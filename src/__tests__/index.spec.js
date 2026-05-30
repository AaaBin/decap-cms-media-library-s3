import s3MediaLibrary, { isImage, buildPublicUrl, makeCredentialsProvider } from '../index';

// ── Mock AWS SDK modules ───────────────────────────────────────────────────
// jest.mock factories are hoisted; no outer variables may be referenced inside them.
// We define self-contained factories and retrieve the mock fns via jest.requireMock().

jest.mock('@aws-sdk/client-s3', () => {
  const mockSend = jest.fn();
  const MockS3Client = jest.fn(() => ({ send: mockSend }));
  MockS3Client._mockSend = mockSend;

  const MockListObjectsV2Command = jest.fn(params => ({ _name: 'ListObjectsV2Command', params }));
  const MockDeleteObjectCommand = jest.fn(params => ({ _name: 'DeleteObjectCommand', params }));
  const MockGetObjectCommand = jest.fn(params => ({ _name: 'GetObjectCommand', params }));

  return { S3Client: MockS3Client, ListObjectsV2Command: MockListObjectsV2Command, DeleteObjectCommand: MockDeleteObjectCommand, GetObjectCommand: MockGetObjectCommand };
});

jest.mock('@aws-sdk/lib-storage', () => {
  const mockDone = jest.fn(() => Promise.resolve({ Location: 'https://bucket.s3.amazonaws.com/key' }));
  const MockUpload = jest.fn(() => ({ done: mockDone }));
  MockUpload._mockDone = mockDone;
  return { Upload: MockUpload };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(() => Promise.resolve('https://signed-url.example.com/key')),
}));

// Convenience accessors for the mock functions
const { S3Client: MockS3Client, ListObjectsV2Command: MockListObjectsV2Command } = jest.requireMock('@aws-sdk/client-s3');
const { Upload: MockUpload } = jest.requireMock('@aws-sdk/lib-storage');

// Mutable list-response state, reset in beforeEach
let mockListResponse = { Contents: [], IsTruncated: false, NextContinuationToken: undefined };

// ── Helpers ────────────────────────────────────────────────────────────────

const defaultConfig = {
  config: {
    bucket: 'my-bucket',
    region: 'us-east-1',
  },
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe('s3 media library exports', () => {
  it('exports an object with expected properties', () => {
    expect(s3MediaLibrary).toMatchInlineSnapshot(`
      Object {
        "init": [Function],
        "name": "s3",
      }
    `);
  });
});

describe('isImage helper', () => {
  it.each(['image.jpg', 'photo.jpeg', 'anim.gif', 'icon.png', 'banner.webp', 'art.svg', 'pic.avif'])(
    'returns true for %s',
    filename => expect(isImage(filename)).toBe(true),
  );

  it.each(['doc.pdf', 'archive.zip', 'data.csv', 'video.mp4', 'README', 'file.JS'])(
    'returns false for %s',
    filename => expect(isImage(filename)).toBe(false),
  );
});

describe('buildPublicUrl helper', () => {
  const base = { key: 'folder/image.jpg', bucket: 'my-bucket', region: 'us-east-1' };

  it('uses base_url when provided', () => {
    const url = buildPublicUrl({ ...base, baseUrl: 'https://cdn.example.com' });
    expect(url).toBe('https://cdn.example.com/folder/image.jpg');
  });

  it('strips trailing slash from base_url', () => {
    const url = buildPublicUrl({ ...base, baseUrl: 'https://cdn.example.com/' });
    expect(url).toBe('https://cdn.example.com/folder/image.jpg');
  });

  it('uses virtual-hosted style for AWS S3 when no endpoint or base_url', () => {
    const url = buildPublicUrl({ ...base, baseUrl: undefined, endpoint: undefined });
    expect(url).toBe('https://my-bucket.s3.us-east-1.amazonaws.com/folder/image.jpg');
  });

  it('uses path-style URL for custom endpoint', () => {
    const url = buildPublicUrl({
      ...base,
      baseUrl: undefined,
      endpoint: 'https://minio.example.com',
    });
    expect(url).toBe('https://minio.example.com/my-bucket/folder/image.jpg');
  });

  it('strips trailing slash from custom endpoint', () => {
    const url = buildPublicUrl({
      ...base,
      baseUrl: undefined,
      endpoint: 'https://minio.example.com/',
    });
    expect(url).toBe('https://minio.example.com/my-bucket/folder/image.jpg');
  });
});

describe('s3 media library', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListResponse = {
      Contents: [],
      IsTruncated: false,
      NextContinuationToken: undefined,
    };
    // Wire up the send mock to return mockListResponse for list commands
    MockS3Client._mockSend.mockImplementation(command => {
      if (command._name === 'ListObjectsV2Command') return Promise.resolve(mockListResponse);
      if (command._name === 'DeleteObjectCommand') return Promise.resolve({});
      return Promise.resolve({});
    });
    document.body.innerHTML = '';
  });

  describe('init', () => {
    it('creates an S3Client with the given config', async () => {
      await s3MediaLibrary.init({ options: defaultConfig });

      expect(MockS3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          region: 'us-east-1',
        }),
      );
    });

    it('passes credentials to S3Client when provided', async () => {
      const options = {
        config: {
          bucket: 'my-bucket',
          region: 'eu-west-1',
          credentials: {
            access_key_id: 'AKIAIOSFODNN7EXAMPLE',
            secret_access_key: 'wJalrXUtnFEMI',
          },
        },
      };
      await s3MediaLibrary.init({ options });
      expect(MockS3Client).toHaveBeenCalledWith(
        expect.objectContaining({
          credentials: {
            accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
            secretAccessKey: 'wJalrXUtnFEMI',
          },
        }),
      );
    });

    it('passes endpoint to S3Client when provided', async () => {
      const options = {
        config: {
          bucket: 'my-bucket',
          region: 'us-east-1',
          endpoint: 'https://minio.example.com',
        },
      };
      await s3MediaLibrary.init({ options });
      expect(MockS3Client).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'https://minio.example.com' }),
      );
    });

    it('defaults forcePathStyle to true when endpoint is provided', async () => {
      const options = {
        config: {
          bucket: 'my-bucket',
          region: 'us-east-1',
          endpoint: 'https://minio.example.com',
        },
      };
      await s3MediaLibrary.init({ options });
      expect(MockS3Client).toHaveBeenCalledWith(
        expect.objectContaining({ forcePathStyle: true }),
      );
    });

    it('injects the modal into document.body', async () => {
      await s3MediaLibrary.init({ options: defaultConfig });
      expect(document.querySelector('.cms-s3-overlay')).not.toBeNull();
    });

    it('injects a style tag into document.head', async () => {
      await s3MediaLibrary.init({ options: defaultConfig });
      expect(document.getElementById('cms-s3-styles')).not.toBeNull();
    });

    it('does not inject duplicate style tags on multiple init calls', async () => {
      await s3MediaLibrary.init({ options: defaultConfig });
      await s3MediaLibrary.init({ options: defaultConfig });
      expect(document.querySelectorAll('#cms-s3-styles').length).toBe(1);
    });

    it('returns an object with show, hide, and enableStandalone', async () => {
      const instance = await s3MediaLibrary.init({ options: defaultConfig });
      expect(instance).toEqual(
        expect.objectContaining({
          show: expect.any(Function),
          hide: expect.any(Function),
          enableStandalone: expect.any(Function),
        }),
      );
    });
  });

  describe('enableStandalone', () => {
    it('returns true', async () => {
      const instance = await s3MediaLibrary.init({ options: defaultConfig });
      expect(instance.enableStandalone()).toBe(true);
    });
  });

  describe('show', () => {
    it('makes the modal visible', async () => {
      const instance = await s3MediaLibrary.init({ options: defaultConfig });
      instance.show();
      const overlay = document.querySelector('.cms-s3-overlay');
      expect(overlay.style.display).toBe('flex');
    });

    it('triggers a ListObjectsV2Command', async () => {
      const instance = await s3MediaLibrary.init({ options: defaultConfig });
      instance.show();
      // flush microtasks
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(MockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ Bucket: 'my-bucket' }),
      );
    });

    it('renders file cards for returned objects', async () => {
      mockListResponse = {
        Contents: [
          { Key: 'photo.jpg', Size: 12345, LastModified: new Date() },
          { Key: 'document.pdf', Size: 6789, LastModified: new Date() },
        ],
        IsTruncated: false,
      };

      const instance = await s3MediaLibrary.init({ options: defaultConfig });
      instance.show();
      await new Promise(resolve => setTimeout(resolve, 0));

      const cards = document.querySelectorAll('.cms-s3-card');
      expect(cards.length).toBe(2);
    });

    it('prepends folder prefix to ListObjectsV2Command when folder is set', async () => {
      const options = {
        config: {
          bucket: 'my-bucket',
          region: 'us-east-1',
          folder: 'uploads',
        },
      };
      const instance = await s3MediaLibrary.init({ options });
      instance.show();
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(MockListObjectsV2Command).toHaveBeenCalledWith(
        expect.objectContaining({ Prefix: 'uploads/' }),
      );
    });

    it('excludes folder-placeholder objects (keys ending with /)', async () => {
      mockListResponse = {
        Contents: [
          { Key: 'uploads/', Size: 0, LastModified: new Date() },
          { Key: 'uploads/photo.jpg', Size: 1000, LastModified: new Date() },
        ],
        IsTruncated: false,
      };

      const instance = await s3MediaLibrary.init({
        options: { config: { ...defaultConfig.config, folder: 'uploads' } },
      });
      instance.show();
      await new Promise(resolve => setTimeout(resolve, 0));

      const cards = document.querySelectorAll('.cms-s3-card');
      expect(cards.length).toBe(1);
    });
  });

  describe('hide', () => {
    it('hides the modal', async () => {
      const instance = await s3MediaLibrary.init({ options: defaultConfig });
      instance.show();
      instance.hide();
      const overlay = document.querySelector('.cms-s3-overlay');
      expect(overlay.style.display).toBe('none');
    });
  });

  describe('file selection and insert', () => {
    it('calls handleInsert with public URL on file selection', async () => {
      mockListResponse = {
        Contents: [{ Key: 'photo.jpg', Size: 1000, LastModified: new Date() }],
        IsTruncated: false,
      };

      const handleInsert = jest.fn();
      const instance = await s3MediaLibrary.init({
        options: defaultConfig,
        handleInsert,
      });
      instance.show();
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = document.querySelector('.cms-s3-card');
      card.click(); // select
      const selectBtn = document.querySelector('.cms-s3-btn-select');
      selectBtn.click();

      expect(handleInsert).toHaveBeenCalledWith(
        'https://my-bucket.s3.us-east-1.amazonaws.com/photo.jpg',
      );
    });

    it('passes base_url-based URL to handleInsert when base_url is configured', async () => {
      mockListResponse = {
        Contents: [{ Key: 'photo.jpg', Size: 1000, LastModified: new Date() }],
        IsTruncated: false,
      };

      const handleInsert = jest.fn();
      const instance = await s3MediaLibrary.init({
        options: {
          config: {
            ...defaultConfig.config,
            base_url: 'https://cdn.example.com',
          },
        },
        handleInsert,
      });
      instance.show();
      await new Promise(resolve => setTimeout(resolve, 0));

      const card = document.querySelector('.cms-s3-card');
      card.click();
      document.querySelector('.cms-s3-btn-select').click();

      expect(handleInsert).toHaveBeenCalledWith('https://cdn.example.com/photo.jpg');
    });

    it('returns array of URLs when allowMultiple is true and multiple files are selected', async () => {
      mockListResponse = {
        Contents: [
          { Key: 'a.jpg', Size: 100, LastModified: new Date() },
          { Key: 'b.jpg', Size: 200, LastModified: new Date() },
        ],
        IsTruncated: false,
      };

      const handleInsert = jest.fn();
      const instance = await s3MediaLibrary.init({ options: defaultConfig, handleInsert });
      instance.show({ allowMultiple: true });
      await new Promise(resolve => setTimeout(resolve, 0));

      document.querySelectorAll('.cms-s3-card').forEach(card => card.click());
      document.querySelector('.cms-s3-btn-select').click();

      expect(handleInsert).toHaveBeenCalledWith(expect.any(Array));
      expect(handleInsert.mock.calls[0][0]).toHaveLength(2);
    });
  });

  describe('upload', () => {
    it('uses Upload from @aws-sdk/lib-storage', async () => {
      const instance = await s3MediaLibrary.init({ options: defaultConfig });
      instance.show();
      await new Promise(resolve => setTimeout(resolve, 0));

      const fileInput = document.querySelector('.cms-s3-file-input');
      const file = new File(['content'], 'new-image.jpg', { type: 'image/jpeg' });

      Object.defineProperty(fileInput, 'files', {
        value: [file],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event('change'));
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(MockUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          params: expect.objectContaining({
            Bucket: 'my-bucket',
            Key: 'new-image.jpg',
            Body: file,
          }),
        }),
      );
    });
  });
});

// ── makeCredentialsProvider tests ──────────────────────────────────────────

describe('makeCredentialsProvider', () => {
  const ENDPOINT = 'https://auth.example.com/s3-token';

  function mockFetchOk(data) {
    return jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(data) }),
    );
  }

  it('returns a function', () => {
    expect(typeof makeCredentialsProvider(ENDPOINT)).toBe('function');
  });

  it('fetches from the endpoint and maps fields to AWS credential names', async () => {
    global.fetch = mockFetchOk({
      access_key_id: 'FETCHED_KEY',
      secret_access_key: 'FETCHED_SECRET',
    });
    const provider = makeCredentialsProvider(ENDPOINT);
    const creds = await provider();
    expect(global.fetch).toHaveBeenCalledWith(ENDPOINT);
    expect(creds).toEqual({ accessKeyId: 'FETCHED_KEY', secretAccessKey: 'FETCHED_SECRET' });
    delete global.fetch;
  });

  it('includes sessionToken when session_token is returned', async () => {
    global.fetch = mockFetchOk({
      access_key_id: 'KEY',
      secret_access_key: 'SECRET',
      session_token: 'TOKEN',
    });
    const creds = await makeCredentialsProvider(ENDPOINT)();
    expect(creds.sessionToken).toBe('TOKEN');
    delete global.fetch;
  });

  it('includes expiration when expiry is returned', async () => {
    const expiryStr = '2026-12-31T00:00:00Z';
    global.fetch = mockFetchOk({
      access_key_id: 'KEY',
      secret_access_key: 'SECRET',
      expiry: expiryStr,
    });
    const creds = await makeCredentialsProvider(ENDPOINT)();
    expect(creds.expiration).toEqual(new Date(expiryStr));
    delete global.fetch;
  });

  it('omits expiration when expiry is not returned', async () => {
    global.fetch = mockFetchOk({ access_key_id: 'KEY', secret_access_key: 'SECRET' });
    const creds = await makeCredentialsProvider(ENDPOINT)();
    expect(creds).not.toHaveProperty('expiration');
    delete global.fetch;
  });

  it('throws when the endpoint returns a non-OK status', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized' }),
    );
    await expect(makeCredentialsProvider(ENDPOINT)()).rejects.toThrow('401');
    delete global.fetch;
  });
});

describe('credentials_endpoint config option', () => {
  const ENDPOINT = 'https://auth.example.com/s3-token';

  beforeEach(() => {
    jest.clearAllMocks();
    MockS3Client._mockSend.mockImplementation(command => {
      if (command._name === 'ListObjectsV2Command')
        return Promise.resolve({ Contents: [], IsTruncated: false });
      return Promise.resolve({});
    });
    document.body.innerHTML = '';
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ access_key_id: 'REMOTE_KEY', secret_access_key: 'REMOTE_SECRET' }),
      }),
    );
  });

  afterEach(() => {
    delete global.fetch;
  });

  it('passes a credentials provider function to S3Client', async () => {
    await s3MediaLibrary.init({
      options: { config: { bucket: 'b', region: 'auto', credentials_endpoint: ENDPOINT } },
    });
    const call = MockS3Client.mock.calls[0][0];
    expect(typeof call.credentials).toBe('function');
  });

  it('provider fetches from the configured endpoint', async () => {
    await s3MediaLibrary.init({
      options: { config: { bucket: 'b', region: 'auto', credentials_endpoint: ENDPOINT } },
    });
    const call = MockS3Client.mock.calls[0][0];
    const creds = await call.credentials();
    expect(global.fetch).toHaveBeenCalledWith(ENDPOINT);
    expect(creds).toMatchObject({ accessKeyId: 'REMOTE_KEY', secretAccessKey: 'REMOTE_SECRET' });
  });

  it('takes precedence over inline credentials when both are provided', async () => {
    await s3MediaLibrary.init({
      options: {
        config: {
          bucket: 'b',
          region: 'auto',
          credentials_endpoint: ENDPOINT,
          credentials: { access_key_id: 'INLINE', secret_access_key: 'INLINE_SECRET' },
        },
      },
    });
    const call = MockS3Client.mock.calls[0][0];
    expect(typeof call.credentials).toBe('function');
  });
});
