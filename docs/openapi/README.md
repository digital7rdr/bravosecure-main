# OpenAPI specs — Bravo Secure

Two OpenAPI 3.0 specs, one per backend service. They describe the
**staging** surface (and by extension local dev — same paths, just
different host).

| File                                                         | Service                                                                                                             | Paths | Ops |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ----: | --: |
| [bravo-auth-service.yaml](bravo-auth-service.yaml)           | `auth-service` (`:3001`) — registration, session, profile, Signal keys, TOTP, biometric, sender cert, conversations |    26 |  29 |
| [bravo-messenger-service.yaml](bravo-messenger-service.yaml) | `messenger-service` (`:3100`) — envelope relay, media/vault pre-signed URLs, push, WebRTC TURN, SFU                 |    12 |  15 |

---

## Upload to SwaggerHub

1. Go to <https://app.swaggerhub.com/> and sign in.
2. **Create New → Create New API → Import and Document API**.
3. Upload `bravo-auth-service.yaml`. SwaggerHub will validate and
   render it.
   - API Name: `bravo-auth-service`
   - Version: `0.1.0`
   - Visibility: Private (or Public if you want to share with
     collaborators).
4. Repeat step 3 with `bravo-messenger-service.yaml` → `bravo-messenger-service`.
5. (Optional) In each API's **Integrations** tab, add the repo URL so
   SwaggerHub syncs from GitHub on every push to `main`.

### Linking the two APIs

Under **Settings → Relationships**, add a reference between the two
APIs so they show as a single bundle. The auth service mints the
bearer token that the messenger service consumes — the link helps
reviewers navigate.

---

## Running Swagger UI locally

If you want to preview without SwaggerHub:

```bash
# option 1 — any static HTTP server + Swagger UI
npx @stoplight/spectral-cli lint docs/openapi/bravo-auth-service.yaml
npx @redocly/cli preview-docs docs/openapi/bravo-auth-service.yaml

# option 2 — docker
docker run --rm -p 8080:8080 \
  -e SWAGGER_JSON=/spec/bravo-auth-service.yaml \
  -v "$(pwd)/docs/openapi":/spec \
  swaggerapi/swagger-ui
```

Then open <http://localhost:8080>.

---

## Testing from inside Swagger UI / SwaggerHub

1. Top-right of the SwaggerHub page → **Authorize**.
2. Paste a bearer token (get one from `POST /auth/register/verify` or
   `POST /auth/verify` — see the `Session` tag in `bravo-auth-service`).
3. Use the **Try it out** button on any endpoint.
4. SwaggerHub auto-injects `Authorization: Bearer <token>` and hits
   the staging host `http://94.136.184.52:3001` /
   `http://94.136.184.52:3100`.

> If CORS blocks browser requests from `app.swaggerhub.com`, use the
> **Auto Mocking** mode (SwaggerHub serves a mock response) or run
> the same requests from Postman using the `.json` collection
> generated from the spec (SwaggerHub → Export → Postman Collection).

---

## Regeneration / maintenance

- DTO shapes live under `apps/auth-service/src/**/dto/*.ts` and
  `apps/messenger-service/src/**/dto/*.ts`. When they change, update
  the matching `components.schemas` entry here.
- Controller routes are discovered by `@Controller(...)` + `@Get/Post/...`
  decorators. A quick grep:
  ```bash
  grep -RE "@(Post|Get|Put|Delete|Patch)\(" apps/auth-service/src apps/messenger-service/src
  ```
- Validate before committing:
  ```bash
  node -e "require('js-yaml').load(require('fs').readFileSync('docs/openapi/bravo-auth-service.yaml','utf8'))"
  ```
- A future improvement: wire in `@nestjs/swagger` so the spec
  generates itself from decorators. For now the handwritten spec is
  easier to review and keeps sensitive internals (audit log formats,
  error shapes) under our control.
