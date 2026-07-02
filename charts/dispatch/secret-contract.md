# Secret Contract

The dispatch chart **does not create Secrets**. It references existing Secrets via
`existingSecret` and `database.existingSecret`. Your platform (ExternalSecret, SOPS,
Vault, etc.) must provision them.

## Required Secret: `existingSecret` (default: `dispatch`)

| Key | Description | Example |
|-----|-------------|---------|
| `DISPATCH_AGENT_TOKEN` | Token used by the dispatch agent to authenticate with GitHub | `ghp_xxxxxxxxxxxx` |
| `GITHUB_TOKEN` | Personal access token for GitHub API calls | `ghp_xxxxxxxxxxxx` |
| `DATABASE_URL` | PostgreSQL connection string (if not using `database.existingSecret`) | `postgresql://user:pass@host/db` |

## Optional Secret keys

| Key | Description |
|-----|-------------|
| `DISPATCH_LLM_BASE_URL` | Override LLM provider base URL (also available via `config.llmBaseUrl`) |
| `DISPATCH_LLM_API_KEY` | API key for the LLM provider |
| `DISPATCH_OIDC_ISSUER` | OIDC issuer URL when `authMode: oidc` |
| `DISPATCH_OIDC_CLIENT_ID` | OIDC client ID |
| `DISPATCH_OIDC_CLIENT_SECRET` | OIDC client secret |

## Database Secret: `database.existingSecret`

When set, the chart reads `DATABASE_URL` from this separate Secret using the key
specified by `database.key` (default: `uri`). This lets you keep database credentials
in a different Secret managed by your database operator.

```yaml
# values.yaml
database:
  existingSecret: dispatch-db-credentials
  key: uri
```

The referenced Secret must contain:

| Key | Description |
|-----|-------------|
| `uri` (or custom `database.key`) | PostgreSQL connection string |
