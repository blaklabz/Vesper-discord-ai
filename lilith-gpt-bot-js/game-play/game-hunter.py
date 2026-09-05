#!/usr/bin/env python3

import argparse
import html
import json
import re
import sys
import urllib.parse
import urllib.request
from html.parser import HTMLParser


APPROVED_DOMAINS = {
    "store.steampowered.com",
    "store.epicgames.com",
    "gog.com",
    "www.gog.com",
    "itch.io",
    "humblebundle.com",
    "www.humblebundle.com",
}

MAX_PAGE_BYTES = 1024 * 1024
HTTP_TIMEOUT = 15


class GamePageParser(HTMLParser):
    def __init__(self):
        super().__init__()

        self.in_title = False
        self.title_parts = []
        self.meta = {}

    def handle_starttag(self, tag, attrs):
        attrs = {
            key.lower(): value
            for key, value in attrs
            if key
        }

        if tag.lower() == "title":
            self.in_title = True
            return

        if tag.lower() != "meta":
            return

        key = (
            attrs.get("property")
            or attrs.get("name")
            or ""
        ).lower()

        content = attrs.get("content")

        if key and content:
            self.meta[key] = content.strip()

    def handle_endtag(self, tag):
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data)

    def get_html_title(self):
        return clean_text(
            " ".join(self.title_parts)
        )


def clean_text(value):
    if not value:
        return None

    value = html.unescape(
        str(value)
    )

    value = re.sub(
        r"\s+",
        " ",
        value,
    ).strip()

    return value or None


def get_hostname(url):
    try:
        parsed = urllib.parse.urlparse(url)

        if parsed.scheme not in (
            "http",
            "https",
        ):
            return None

        return (
            parsed.hostname
            or ""
        ).lower()

    except Exception:
        return None


def is_approved_url(url):
    hostname = get_hostname(url)

    if not hostname:
        return False

    if hostname in APPROVED_DOMAINS:
        return True

    if hostname.endswith(".itch.io"):
        return True

    return False


def get_source(url):
    hostname = get_hostname(url)

    if hostname == "store.steampowered.com":
        return "steam"

    if hostname == "store.epicgames.com":
        return "epic"

    if hostname in (
        "gog.com",
        "www.gog.com",
    ):
        return "gog"

    if (
        hostname == "itch.io"
        or hostname.endswith(".itch.io")
    ):
        return "itch"

    if hostname in (
        "humblebundle.com",
        "www.humblebundle.com",
    ):
        return "humble"

    return "unknown"


def build_request(url, accept=None):
    headers = {
        "User-Agent": (
            "Mozilla/5.0 "
            "(compatible; VesperGameHunter/1.0)"
        ),
    }

    if accept:
        headers["Accept"] = accept

    return urllib.request.Request(
        url,
        headers=headers,
    )


def fetch_page(url):
    request = build_request(
        url,
        accept=(
            "text/html,"
            "application/xhtml+xml"
        ),
    )

    with urllib.request.urlopen(
        request,
        timeout=HTTP_TIMEOUT,
    ) as response:

        final_url = response.geturl()

        if not is_approved_url(final_url):
            raise ValueError(
                "redirected_to_unapproved_domain"
            )

        content_type = response.headers.get(
            "Content-Type",
            "",
        )

        if (
            "text/html"
            not in content_type.lower()
        ):
            raise ValueError(
                "unsupported_content_type"
            )

        body = response.read(
            MAX_PAGE_BYTES
        )

        charset = (
            response.headers
            .get_content_charset()
        )

        if not charset:
            charset = "utf-8"

        return {
            "url": final_url,
            "content_type": content_type,
            "body": body.decode(
                charset,
                errors="replace",
            ),
        }


def fetch_json(url):
    request = build_request(
        url,
        accept="application/json",
    )

    with urllib.request.urlopen(
        request,
        timeout=HTTP_TIMEOUT,
    ) as response:

        body = response.read(
            MAX_PAGE_BYTES
        )

        charset = (
            response.headers
            .get_content_charset()
        )

        if not charset:
            charset = "utf-8"

        text = body.decode(
            charset,
            errors="replace",
        )

        try:
            return json.loads(text)

        except json.JSONDecodeError:
            raise ValueError(
                "invalid_json_response"
            )


def parse_game_page(body):
    parser = GamePageParser()

    parser.feed(body)

    meta = parser.meta

    page_title = (
        clean_text(
            meta.get("og:title")
        )
        or clean_text(
            meta.get("twitter:title")
        )
        or parser.get_html_title()
    )

    description = (
        clean_text(
            meta.get("og:description")
        )
        or clean_text(
            meta.get("twitter:description")
        )
        or clean_text(
            meta.get("description")
        )
    )

    image = (
        clean_text(
            meta.get("og:image")
        )
        or clean_text(
            meta.get("twitter:image")
        )
    )

    return {
        "page_title": page_title,
        "description": description,
        "image": image,
    }


def clean_page_title(title):
    title = clean_text(title)

    if not title:
        return None

    suffixes = (
        " on Steam",
        " | Steam",
        " - Steam",
        " on GOG.com",
        " | GOG.com",
        " - GOG.com",
        " | Epic Games Store",
        " - Epic Games Store",
        " on Epic Games Store",
    )

    for suffix in suffixes:
        if title.endswith(suffix):
            title = title[
                :-len(suffix)
            ].strip()

    return title


def choose_title(
    supplied_title,
    page_title,
):
    supplied_title = clean_text(
        supplied_title
    )

    if supplied_title:
        return supplied_title

    return clean_page_title(
        page_title
    )


def get_steam_appid(url):
    hostname = get_hostname(url)

    if hostname != "store.steampowered.com":
        return None

    parsed = urllib.parse.urlparse(url)

    match = re.search(
        r"/app/(\d+)",
        parsed.path,
    )

    if not match:
        return None

    return int(
        match.group(1)
    )


def get_steam_reviews(appid):
    if not appid:
        return None

    params = urllib.parse.urlencode(
        {
            "json": 1,
            "filter": "all",
            "language": "all",
            "purchase_type": "all",
            "num_per_page": 1,
        }
    )

    url = (
        "https://store.steampowered.com/"
        f"appreviews/{appid}"
        f"?{params}"
    )

    try:
        data = fetch_json(url)

    except Exception as error:
        return {
            "available": False,
            "error": str(error),
        }

    if data.get("success") != 1:
        return {
            "available": False,
            "error": "steam_review_request_failed",
        }

    summary = (
        data.get("query_summary")
        or {}
    )

    positive = int(
        summary.get(
            "total_positive",
            0,
        )
        or 0
    )

    negative = int(
        summary.get(
            "total_negative",
            0,
        )
        or 0
    )

    total = int(
        summary.get(
            "total_reviews",
            0,
        )
        or 0
    )

    if total > 0:
        positive_percent = round(
            (positive / total) * 100,
            1,
        )
    else:
        positive_percent = None

    return {
        "available": True,
        "summary": clean_text(
            summary.get(
                "review_score_desc"
            )
        ),
        "score": summary.get(
            "review_score"
        ),
        "positive_percent":
            positive_percent,
        "positive": positive,
        "negative": negative,
        "total": total,
    }


def build_game_context(
    source,
    url,
):
    context = {
        "reviews": None,
    }

    if source == "steam":
        appid = get_steam_appid(
            url
        )

        context["steam"] = {
            "appid": appid,
        }

        context["reviews"] = (
            get_steam_reviews(
                appid
            )
        )

    return context


def main():
    parser = argparse.ArgumentParser(
        description=(
            "Gather storefront and review "
            "information for Vesper."
        )
    )

    parser.add_argument(
        "--url",
        required=True,
    )

    parser.add_argument(
        "--title",
        default=None,
    )

    args = parser.parse_args()

    url = args.url
    supplied_title = args.title

    if not is_approved_url(url):
        print(
            json.dumps(
                {
                    "status":
                        "blocked_source",
                    "title":
                        supplied_title,
                    "url":
                        url,
                    "reason":
                        "domain_not_approved",
                },
                ensure_ascii=False,
            )
        )

        return 0

    try:
        page = fetch_page(url)

        source = get_source(
            page["url"]
        )

        parsed = parse_game_page(
            page["body"]
        )

        title = choose_title(
            supplied_title,
            parsed["page_title"],
        )

        game_context = (
            build_game_context(
                source,
                page["url"],
            )
        )

        result = {
            "status": "ok",
            "source": source,
            "title": title,
            "page_title":
                parsed["page_title"],
            "url": page["url"],
            "description":
                parsed["description"],
            "image":
                parsed["image"],
            "reviews":
                game_context["reviews"],
        }

        if "steam" in game_context:
            result["steam"] = (
                game_context["steam"]
            )

        print(
            json.dumps(
                result,
                ensure_ascii=False,
            )
        )

        return 0

    except Exception as error:
        print(
            json.dumps(
                {
                    "status": "error",
                    "title":
                        supplied_title,
                    "url": url,
                    "error":
                        str(error),
                },
                ensure_ascii=False,
            )
        )

        return 1


if __name__ == "__main__":
    sys.exit(
        main()
    )
