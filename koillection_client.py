"""Minimal client for the Koillection 1.8.1 REST API.

Handles JWT auth (with automatic re-authentication on expiry), Hydra-style
pagination, and the items/data/tags/choice-list operations the add wizard
needs. Knows nothing about movies/TV — that belongs in fields.py/tagging.py.

Started as a copy of koicli's koillection_client.py (/home/pi/Scripts/koicli);
the two have since diverged in both directions, so changes to one don't carry
over to the other.
"""
from __future__ import annotations

import concurrent.futures
import json
from typing import Any, Iterable

import requests

PAGE_FETCH_CONCURRENCY = 16


class KoillectionError(RuntimeError):
    pass


def encode_datum_value(datum_type: str, value: Any) -> str | None:
    """Encode a Python value into the string form Koillection's API expects.

    ``list``/``choice-list`` data store a JSON-encoded array *as a string*;
    everything else is just the string form (or ``None``).
    """
    if value is None:
        return None
    if datum_type in ("list", "choice-list"):
        return json.dumps(list(value), ensure_ascii=False)
    return str(value)


def choice_list_values(choice_list: dict) -> list[str]:
    """A ChoiceList's ``choices`` comes back as a plain JSON array normally,
    but as a ``{"0": "Action", "1": ..., "14": ...}`` object once an entry has
    ever been deleted from the middle. Handle both shapes."""
    choices = choice_list.get("choices") or []
    if isinstance(choices, dict):
        return list(choices.values())
    return list(choices)


class KoillectionClient:
    def __init__(self, base_url: str, username: str, password: str):
        self.base_url = base_url.rstrip("/")
        self.username = username
        self.password = password
        self.session = requests.Session()
        self.session.headers["Accept"] = "application/ld+json"
        self._token: str | None = None

        self._choice_list_cache: dict[str, dict] = {}
        self._tag_category_cache: dict[str, dict] | None = None
        self._tag_cache_by_label: dict[str, dict] | None = None

    # ------------------------------------------------------------------
    # Auth & low-level request plumbing
    # ------------------------------------------------------------------
    def authenticate(self) -> None:
        """Perform (or re-perform) the login handshake. Raises KoillectionError
        with the real status code/body on failure — callers use this to check
        a user-entered username/password against the live server."""
        resp = self.session.post(
            f"{self.base_url}/api/authentication_token",
            json={"username": self.username, "password": self.password},
            # Drop the old Bearer header (None removes it for this request):
            # Koillection rejects the login itself with "Expired JWT Token"
            # if a stale one is sent along.
            headers={"Content-Type": "application/json", "Authorization": None},
            timeout=15,
        )
        if resp.status_code != 200:
            raise KoillectionError(
                f"Koillection authentication failed ({resp.status_code}): {resp.text[:200]}"
            )
        self._token = resp.json()["token"]
        self.session.headers["Authorization"] = f"Bearer {self._token}"

    def _url(self, path: str) -> str:
        return path if path.startswith("http") else f"{self.base_url}{path}"

    def _request(self, method: str, path: str, *, retried: bool = False, **kwargs) -> requests.Response:
        if self._token is None:
            self.authenticate()
        kwargs.setdefault("timeout", 30)
        resp = self.session.request(method, self._url(path), **kwargs)
        if resp.status_code == 401 and not retried:
            self.authenticate()
            return self._request(method, path, retried=True, **kwargs)
        if resp.status_code >= 400:
            raise KoillectionError(
                f"{method} {path} -> {resp.status_code}: {resp.text[:300]}"
            )
        return resp

    def _get_json(self, path: str, **kwargs) -> dict:
        return self._request("GET", path, **kwargs).json()

    def _post_json(self, path: str, payload: dict, **kwargs) -> dict:
        return self._request(
            "POST", path, json=payload,
            headers={"Content-Type": "application/json"}, **kwargs,
        ).json()

    def _patch_json(self, path: str, payload: dict, **kwargs) -> dict:
        return self._request(
            "PATCH", path, json=payload,
            headers={"Content-Type": "application/merge-patch+json"}, **kwargs,
        ).json()

    def _post_multipart(self, path: str, files: dict, **kwargs) -> dict:
        return self._request("POST", path, files=files, **kwargs).json()

    # ------------------------------------------------------------------
    # Pagination
    # ------------------------------------------------------------------
    def _paginate(self, path: str, params: dict | None = None) -> list[dict]:
        items: list[dict] = []
        page = 1
        base_params = dict(params or {})
        while True:
            data = self._get_json(path, params={**base_params, "page": page})
            members = data.get("member", [])
            if not members:
                break
            items.extend(members)
            total = data.get("totalItems")
            if total is not None and len(items) >= total:
                break
            page += 1
        return items

    def _paginate_concurrent(self, path: str, params: dict | None = None) -> list[dict]:
        """Fetch a Hydra collection's pages concurrently (for large lists like /api/tags)."""
        base_params = dict(params or {})
        first = self._get_json(path, params={**base_params, "page": 1})
        members = list(first.get("member", []))
        total = first.get("totalItems") or len(members)
        page_size = len(members) or 1
        if len(members) >= total:
            return members

        import math
        last_page = math.ceil(total / page_size)

        def fetch(page: int) -> list[dict]:
            return self._get_json(path, params={**base_params, "page": page}).get("member", [])

        with concurrent.futures.ThreadPoolExecutor(max_workers=PAGE_FETCH_CONCURRENCY) as ex:
            for page_members in ex.map(fetch, range(2, last_page + 1)):
                members.extend(page_members)
        return members

    # ------------------------------------------------------------------
    # Collections / Items
    # ------------------------------------------------------------------
    def get_collection_by_title(self, title: str) -> dict | None:
        for c in self._paginate("/api/collections"):
            if c.get("title") == title:
                return c
        return None

    def list_items(self, collection_id: str) -> list[dict]:
        return self._paginate(f"/api/collections/{collection_id}/items")

    def get_item_data(self, item_id: str) -> list[dict]:
        return self._paginate(f"/api/items/{item_id}/data")

    def create_item(self, name: str, collection_iri: str, tag_iris: Iterable[str] | None = None) -> dict:
        payload: dict[str, Any] = {"name": name, "collection": collection_iri}
        if tag_iris:
            payload["tags"] = list(tag_iris)
        return self._post_json("/api/items", payload)

    def upload_item_image(self, item_id: str, filename: str, content: bytes, content_type: str) -> dict:
        return self._post_multipart(
            f"/api/items/{item_id}/image",
            files={"file": (filename, content, content_type)},
        )

    # ------------------------------------------------------------------
    # Data (the per-item custom fields)
    # ------------------------------------------------------------------
    def create_datum(
        self,
        *,
        item_iri: str,
        datum_type: str,
        label: str,
        value: Any = None,
        position: int | None = None,
        choice_list_iri: str | None = None,
    ) -> dict:
        payload: dict[str, Any] = {"item": item_iri, "type": datum_type, "label": label}
        encoded = encode_datum_value(datum_type, value)
        if encoded is not None:
            payload["value"] = encoded
        if position is not None:
            payload["position"] = position
        if choice_list_iri is not None:
            payload["choiceList"] = choice_list_iri
        return self._post_json("/api/data", payload)

    def update_datum(self, datum_id: str, **fields) -> dict:
        return self._patch_json(f"/api/data/{datum_id}", fields)

    # ------------------------------------------------------------------
    # Choice lists (cached by name)
    # ------------------------------------------------------------------
    def get_choice_list_by_name(self, name: str) -> dict | None:
        if name in self._choice_list_cache:
            return self._choice_list_cache[name]
        for cl in self._paginate("/api/choice_lists"):
            self._choice_list_cache[cl["name"]] = cl
        return self._choice_list_cache.get(name)

    # ------------------------------------------------------------------
    # Tag categories (cached, label -> record)
    # ------------------------------------------------------------------
    def _ensure_tag_category_cache(self) -> dict[str, dict]:
        if self._tag_category_cache is None:
            self._tag_category_cache = {
                c["label"]: c for c in self._paginate("/api/tag_categories")
            }
        return self._tag_category_cache

    def category_label_of(self, tag: dict) -> str | None:
        cache = self._ensure_tag_category_cache()
        iri_to_label = {c["@id"]: label for label, c in cache.items()}
        category = tag.get("category")
        iri = category if isinstance(category, str) else (category or {}).get("@id")
        return iri_to_label.get(iri)

    def find_or_create_category(self, label: str) -> str:
        cache = self._ensure_tag_category_cache()
        cat = cache.get(label)
        if cat:
            return cat["@id"]
        created = self._post_json("/api/tag_categories", {"label": label})
        cache[label] = created
        return created["@id"]

    # ------------------------------------------------------------------
    # Tags (cached, label.lower() -> record; ~3500 tags so loaded concurrently)
    # ------------------------------------------------------------------
    def _ensure_tag_cache(self) -> dict[str, dict]:
        if self._tag_cache_by_label is None:
            self._tag_cache_by_label = {
                t["label"].lower(): t for t in self._paginate_concurrent("/api/tags")
            }
        return self._tag_cache_by_label

    def find_tag(self, label: str) -> dict | None:
        return self._ensure_tag_cache().get(label.lower())

    def all_tags(self) -> list[dict]:
        return list(self._ensure_tag_cache().values())

    def create_tag(self, label: str, category_iri: str | None = None) -> dict:
        payload: dict[str, Any] = {"label": label}
        if category_iri:
            payload["category"] = category_iri
        created = self._post_json("/api/tags", payload)
        self._ensure_tag_cache()[label.lower()] = created
        return created

    def find_or_create_tag(self, label: str, category_iri: str | None = None) -> dict:
        existing = self.find_tag(label)
        if existing:
            return existing
        return self.create_tag(label, category_iri=category_iri)
