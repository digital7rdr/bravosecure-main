#!/usr/bin/env python3
"""
App Store Connect helper for the iOS release pipeline.

  --next     print the next unused build number (highest uploaded + 1)
  --status   print processing / TestFlight state of recent builds

Used by scripts/ios-release.sh so build numbers are derived from what ASC has
actually seen, rather than hand-tracked in app.json (which is how build 143 got
cut against an already-used number).

Auth uses the App Store Connect API key (ES256 JWT). The .p8 lives outside the
repo at ~/.appstoreconnect/private_keys/ and is gitignored everywhere.
"""
import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.request

DEFAULT_KEY_ID = "S6379ZCA56"
DEFAULT_ISSUER = "413b1e93-d5ea-46d2-85c0-838c6aebfba7"
DEFAULT_BUNDLE = "com.bravosecure.mobile"
API = "https://api.appstoreconnect.apple.com"


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def make_token(key_id: str, issuer: str, key_path: str) -> str:
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric import utils as asym_utils
    except ImportError:
        sys.exit("missing dependency: pip3 install cryptography")

    with open(key_path, "rb") as fh:
        key = serialization.load_pem_private_key(fh.read(), password=None)
    now = int(time.time())
    header = {"alg": "ES256", "kid": key_id, "typ": "JWT"}
    payload = {"iss": issuer, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}
    signing_input = f"{_b64(json.dumps(header).encode())}.{_b64(json.dumps(payload).encode())}".encode()
    der = key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = asym_utils.decode_dss_signature(der)
    return f"{signing_input.decode()}.{_b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def call(token: str, path: str):
    req = urllib.request.Request(f"{API}{path}", method="GET")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def get_builds(token: str, bundle_id: str, limit: int = 10):
    st, apps = call(token, f"/v1/apps?filter[bundleId]={bundle_id}")
    if st != 200 or not apps.get("data"):
        sys.exit(f"app lookup failed ({st}) for {bundle_id}")
    app_id = apps["data"][0]["id"]
    st, builds = call(
        token,
        f"/v1/builds?filter[app]={app_id}&limit={limit}"
        "&sort=-uploadedDate&include=buildBetaDetail",
    )
    if st != 200:
        sys.exit(f"build list failed ({st})")
    details = {
        i["id"]: i["attributes"]
        for i in builds.get("included", [])
        if i["type"] == "buildBetaDetails"
    }
    out = []
    for b in builds.get("data", []):
        rel = (b.get("relationships", {}).get("buildBetaDetail", {}).get("data") or {})
        out.append((b["attributes"], details.get(rel.get("id"), {})))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--next", action="store_true", help="print next unused build number")
    ap.add_argument("--status", action="store_true", help="print recent build states")
    ap.add_argument("--key-id", default=DEFAULT_KEY_ID)
    ap.add_argument("--issuer", default=DEFAULT_ISSUER)
    ap.add_argument("--bundle-id", default=DEFAULT_BUNDLE)
    ap.add_argument("--key-path", default=None)
    args = ap.parse_args()

    if not (args.next or args.status):
        ap.error("pass --next or --status")

    import os

    key_path = args.key_path or os.path.expanduser(
        f"~/.appstoreconnect/private_keys/AuthKey_{args.key_id}.p8"
    )
    token = make_token(args.key_id, args.issuer, key_path)
    builds = get_builds(token, args.bundle_id)

    if args.next:
        highest = 0
        for attrs, _ in builds:
            try:
                highest = max(highest, int(attrs.get("version") or 0))
            except (TypeError, ValueError):
                continue
        print(highest + 1)
        return

    if not builds:
        print("no builds uploaded yet")
        return
    for attrs, detail in builds:
        print(f"Build {attrs.get('version')}  uploaded {attrs.get('uploadedDate')}")
        print(f"   processing : {attrs.get('processingState')}")
        print(f"   internal   : {detail.get('internalBuildState')}")
        print(f"   external   : {detail.get('externalBuildState')}")
        print(f"   expired    : {attrs.get('expired')}")
        print()


if __name__ == "__main__":
    main()
