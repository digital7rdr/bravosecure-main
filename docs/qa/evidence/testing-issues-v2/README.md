# Evidence — BRAVO SECURE App Testing Issues V2

Screenshots extracted from `BRAVO SECURE App Testing Issues V2.pdf` (50 pages, 45 issues, 19 July 2026, v2.0).

**Fix plan:** [`docs/handoffs/BOOKING_BUGS_V2_FIX_PLAN.md`](../../../handoffs/BOOKING_BUGS_V2_FIX_PLAN.md)
**Full PDF text:** [`PDF_TEXT.txt`](PDF_TEXT.txt) — all 50 pages, page-delimited.

## Naming

`pNN.jpeg` = the single screenshot on PDF page `NN`.
`pNNA/B/C.jpeg` = pages carrying 2–3 shots, in the A/B/C order the PDF labels them.

Page number = the PDF page, which maps to the issue as: **issue number + 5 = page number** (issue 01 is page 6, issue 45 is page 50).

## Booking-related pages

| Pages | Group                                               |
| ----- | --------------------------------------------------- |
| 16    | Mission comms (Issue 11)                            |
| 23–26 | Department Chat & Vault (Issues 18–21)              |
| 27–38 | Secure Services client flow (Issues 22–33)          |
| 39–45 | Agent & Service Provider (Issues 34–40)             |
| 46–50 | Mission acceptance & live operations (Issues 41–45) |

Pages 6–15 and 17–22 are Messenger-only (Issues 01–10, 12–17) — see §7 of the fix plan.

## Regenerating

```bash
python -c "
import fitz, os
d = fitz.open(r'<path-to>/BRAVO SECURE App Testing Issues V2.pdf')
dst = 'docs/qa/evidence/testing-issues-v2'
os.makedirs(dst, exist_ok=True)
for pi, p in enumerate(d, 1):
    imgs = p.get_images(full=True)
    for k, im in enumerate(imgs):
        base = d.extract_image(im[0])
        suf = chr(65 + k) if len(imgs) > 1 else ''
        open(os.path.join(dst, f'p{pi:02d}{suf}.{base[\"ext\"]}'), 'wb').write(base['image'])
"
```

Requires PyMuPDF (`fitz`). Note `pdftoppm`/poppler is **not** installed on this machine, so the Read tool cannot render the PDF directly — extract first, then read the images.
