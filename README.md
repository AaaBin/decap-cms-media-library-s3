# decap-cms-media-library-s3

S3-compatible object storage media library integration for [Decap CMS](https://decapcms.org).

Supports any S3-compatible service:
- **AWS S3**
- **MinIO**
- **DigitalOcean Spaces**
- **Backblaze B2**
- **Cloudflare R2**
- **Wasabi**
- And any other S3-API-compatible object storage

## Installation

```bash
npm install decap-cms-media-library-s3
```

Then register the library in your CMS configuration code:

```js
import CMS from 'decap-cms-app';
import S3 from 'decap-cms-media-library-s3';

CMS.registerMediaLibrary(S3);
```

## Configuration

Add a `media_library` section to your `config.yml`:

```yaml
media_library:
  name: s3
  config:
    bucket: my-bucket
    region: us-east-1
    credentials:
      access_key_id: AKIAIOSFODNN7EXAMPLE
      secret_access_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
    # Optional: only required for non-AWS S3-compatible services
    endpoint: https://minio.example.com
    # Optional: default true when endpoint is set
    force_path_style: true
    # Optional: key prefix inside the bucket (acts as a folder)
    folder: uploads
    # Optional: CDN or public base URL for constructing file URLs
    base_url: https://cdn.example.com
```

### Configuration options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `bucket` | Yes | — | The S3 bucket name |
| `region` | No | `us-east-1` | AWS region (or equivalent for compatible services) |
| `credentials_endpoint` | No | — | URL of a backend endpoint that returns temporary credentials (recommended — see [Secure credential management](#secure-credential-management)) |
| `credentials.access_key_id` | No | — | AWS access key ID (can also use IAM role or env vars) |
| `credentials.secret_access_key` | No | — | AWS secret access key |
| `credentials.session_token` | No | — | Temporary session token (e.g. from STS) |
| `endpoint` | No | — | Custom endpoint URL for non-AWS services |
| `force_path_style` | No | `true` when `endpoint` is set | Use path-style URLs instead of virtual-hosted |
| `folder` | No | — | Key prefix used as a folder within the bucket |
| `base_url` | No | — | Base URL to use when constructing inserted file URLs (e.g. a CDN URL) |

## URL construction

Inserted file URLs are constructed as follows (in order of priority):

1. **`base_url` set**: `${base_url}/${key}`  
   e.g. `https://cdn.example.com/uploads/image.jpg`

2. **Custom `endpoint` (no `base_url`)**: `${endpoint}/${bucket}/${key}`  
   e.g. `https://minio.example.com/my-bucket/uploads/image.jpg`

3. **AWS S3 (no `endpoint` or `base_url`)**: virtual-hosted style  
   e.g. `https://my-bucket.s3.us-east-1.amazonaws.com/uploads/image.jpg`

## Secure credential management

Storing `secret_access_key` directly in `config.yml` is a **security risk** because that file is typically committed to a public repository and served to every browser that opens the CMS.

The recommended approach is to expose a **credentials endpoint** — a small server-side function that holds the secret and returns short-lived credentials on demand. The CMS fetches credentials from that URL at startup and (if an `expiry` timestamp is returned) refreshes them automatically before they expire.

### credentials_endpoint

Set `credentials_endpoint` to a URL that returns a JSON object:

```json
{
  "access_key_id": "...",
  "secret_access_key": "...",
  "session_token": "...",
  "expiry": "2026-01-01T12:00:00Z"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `access_key_id` | Yes | Access key ID |
| `secret_access_key` | Yes | Secret access key |
| `session_token` | No | Temporary session token (e.g. from AWS STS `AssumeRole`) |
| `expiry` | No | ISO 8601 timestamp — when present the SDK re-fetches credentials before this time |

The endpoint **must** be protected by authentication (e.g. the same OAuth session that guards the CMS). Never return credentials to unauthenticated callers.

`credentials_endpoint` takes precedence over an inline `credentials` block when both are present.

#### Cloudflare R2 — Cloudflare Worker

Create an [R2 API token](https://developers.cloudflare.com/r2/api/tokens/#permissions) scoped to only the required permissions (`Object Read & Write` on the target bucket). Store it in a Worker secret and return it from a protected route:

```yaml
# config.yml  — no secrets here
media_library:
  name: s3
  config:
    bucket: my-bucket
    region: auto
    endpoint: https://<account-id>.r2.cloudflarestorage.com
    credentials_endpoint: https://my-worker.example.workers.dev/cms-credentials
    base_url: https://pub-<hash>.r2.dev
```

```js
// worker.js
export default {
  async fetch(request, env) {
    // Validate the caller — e.g. check a ****** tied to the CMS user's session
    const auth = request.headers.get('Authorization') ?? '';
    if (!isValidSession(auth, env)) {
      return new Response('Unauthorized', { status: 401 });
    }

    return Response.json({
      access_key_id: env.R2_ACCESS_KEY_ID,
      secret_access_key: env.R2_SECRET_ACCESS_KEY,
    });
  },
};
```

#### AWS S3 — Next.js API route

```yaml
# config.yml
media_library:
  name: s3
  config:
    bucket: my-bucket
    region: us-east-1
    credentials_endpoint: /api/s3-credentials
```

```js
// pages/api/s3-credentials.js
import { getServerSession } from 'next-auth/next';
import { authOptions } from './auth/[...nextauth]';

export default async function handler(req, res) {
  const session = await getServerSession(req, res, authOptions);
  if (!session) return res.status(401).end();

  res.json({
    access_key_id: process.env.S3_ACCESS_KEY_ID,
    secret_access_key: process.env.S3_SECRET_ACCESS_KEY,
    // Optionally return an expiry to trigger automatic refresh:
    // expiry: new Date(Date.now() + 3600_000).toISOString(),
  });
}
```

#### AWS S3 — short-lived STS credentials

For fine-grained, time-limited access you can use [AWS STS `AssumeRole`](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html) and return the temporary credentials with an `expiry`:

```js
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

const sts = new STSClient({ region: 'us-east-1' });

export default async function handler(req, res) {
  // authenticate the caller first …
  const { Credentials } = await sts.send(
    new AssumeRoleCommand({
      RoleArn: process.env.CMS_ROLE_ARN,
      RoleSessionName: 'decap-cms',
      DurationSeconds: 3600,
    }),
  );
  res.json({
    access_key_id: Credentials.AccessKeyId,
    secret_access_key: Credentials.SecretAccessKey,
    session_token: Credentials.SessionToken,
    expiry: Credentials.Expiration.toISOString(),
  });
}
```

## S3 for Non-AWS Services

### MinIO

```yaml
media_library:
  name: s3
  config:
    bucket: my-bucket
    region: us-east-1
    endpoint: https://minio.your-domain.com
    force_path_style: true
    credentials:
      access_key_id: minio-access-key
      secret_access_key: minio-secret-key
```

### DigitalOcean Spaces

```yaml
media_library:
  name: s3
  config:
    bucket: my-space
    region: nyc3
    endpoint: https://nyc3.digitaloceanspaces.com
    credentials:
      access_key_id: DO_SPACES_KEY
      secret_access_key: DO_SPACES_SECRET
    base_url: https://my-space.nyc3.cdn.digitaloceanspaces.com
```

### Cloudflare R2

```yaml
media_library:
  name: s3
  config:
    bucket: my-bucket
    region: auto
    endpoint: https://<account-id>.r2.cloudflarestorage.com
    credentials_endpoint: https://my-worker.example.workers.dev/cms-credentials
    base_url: https://pub-<hash>.r2.dev
```

> See [Secure credential management](#secure-credential-management) for a Cloudflare Worker example that serves the credentials endpoint.

## Important Notes

### CORS configuration

Your S3 bucket must have a CORS policy that allows the CMS origin. Example:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": ["https://your-cms-domain.example.com"],
    "ExposeHeaders": ["ETag"]
  }
]
```

### Credential security

- Use IAM credentials with the **minimum required permissions**: `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the target bucket only.
- **Do not use root credentials** or credentials with broad permissions.
- **Do not put secrets in `config.yml`** — this file is typically public. Use [`credentials_endpoint`](#secure-credential-management) to fetch credentials from a protected backend endpoint instead.

### Public vs private buckets

- For **public buckets**, objects are directly accessible at their public URL, which is what gets inserted into content.
- For **private buckets**, the media library uses presigned URLs for thumbnail preview within the modal. However, the URL stored in your content will be the permanent public URL — make sure your bucket/CDN serves these publicly or handle access at the application level.
