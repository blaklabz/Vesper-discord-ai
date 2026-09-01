#!/usr/bin/env python3

import argparse
import json
import sys
import urllib.parse
import urllib.request


APPROVED_DOMAINS = {
    "store.steampowered.com",
    "store.epicgames.com",
    "gog.com",
    "www.gog.com",
    "itch.io",
    "humblebundle.com",
    "www.humblebundle.com",
}


def get_hostname(url):
    try:
        parsed = urllib.parse.urlparse(url)

        if parsed.scheme not in ("http", "https"):
            return None

        return (parsed.hostname or "").lower()

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


def fetch_page(url):
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 "
                "(compatible; VesperGameHunter/1.0)"
            )
        },
    )

    with urllib.request.urlopen(
        request,
        timeout=15,
    ) as response:
        content_type = (
            response.headers.get(
                "Content-Type",
                "",
            )
        )

        body = response.read(
            1024 * 1024
        )

        return {
            "content_type":
                content_type,

            "body":
                body.decode(
                    "utf-8",
                    errors="replace",
                ),
        }


def main():
    parser = argparse.ArgumentParser()

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
    title = args.title

    if not is_approved_url(url):
        print(
            json.dumps(
                {
                    "status":
                        "blocked_source",

                    "title":
                        title,

                    "url":
                        url,

                    "reason":
                        "domain_not_approved",
                }
            )
        )

        return 0

    try:
        page = fetch_page(url)

        print(
            json.dumps(
                {
                    "status":
                        "ok",

                    "title":
                        title,

                    "url":
                        url,

                    "content_type":
                        page[
                            "content_type"
                        ],

                    # Temporary raw page data.
                    # Phase 2 can turn this into
                    # proper game/review context.
                    "page_text":
                        page["body"][:50000],
                }
            )
        )

        return 0

    except Exception as error:
        print(
            json.dumps(
                {
                    "status":
                        "error",

                    "title":
                        title,

                    "url":
                        url,

                    "error":
                        str(error),
                }
            )
        )

        return 1


if __name__ == "__main__":
    sys.exit(main())
