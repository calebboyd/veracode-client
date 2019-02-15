const VeracodeClient = require('./VeracodeClient');
const crypto = require('crypto');
const request = require('request');
const { URL } = require('url');
const fs = require('fs');
const archiver = require('archiver');

const mockApiId = 'fake';
const mockApiSecret = 'also-fake';
const mockNonce = new Buffer('asdf');
const mockDate = new Date('2001-09-11T08:46:00');
const realDateNow = Date.now;
const veracodeClient = new VeracodeClient(mockApiId, mockApiSecret);

jest.spyOn(crypto, 'randomBytes').mockImplementation((size) => {
  expect(typeof size).toBe('number');
  return mockNonce;
})

jest.mock('request');
jest.mock('fs');
jest.mock('archiver');

function computeHash (data, key) {
  const hmac = crypto.createHmac('sha256', key);
  hmac.update(data);
  return hmac.digest();
}

function mockAuthHeader(url, method) {
  const data = `id=${mockApiId}&host=${url.host}&url=${url.pathname + url.search}&method=${method}`;

  const hashedNonce = computeHash(mockNonce, Buffer.from(mockApiSecret, 'hex'));
  const hashedDate = computeHash(mockDate.toString(), hashedNonce);
  const hashedVersionCode = computeHash('vcode_request_version_1', hashedDate);
  const signature = computeHash(data, hashedVersionCode);

  const authParam = `id=${mockApiId},ts=${mockDate.toString()},nonce=${mockNonce.toString('hex')},sig=${signature.toString('hex')}`;
  return `VERACODE-HMAC-SHA-256 ${authParam}`;
}

function baseRequestArg(url, method = 'POST') {
  return {
    method: method,
    uri: url,
    headers: {
      'Authorization': mockAuthHeader(url, method)
    },
    gzip: true
  };
}

beforeAll(() => {
  Date.now = jest.fn().mockReturnValue(mockDate);
});

afterAll(() => {
  Date.now = realDateNow;
});

test('#calculateAuthorizationHeader', async () => {
  const url = new URL('action.do', veracodeClient.apiBase);
  const authHeader = veracodeClient.calculateAuthorizationHeader(url, 'GET');
  expect(authHeader).toBe(mockAuthHeader(url, 'GET'));
});

describe("#_request", () => {
  test('parses xml', async () => {
    request.mockResolvedValue(`
    <test account_id="123" app_id="456">
      <nested nested_id="789"/>
    </test>
    `);
    const response = await veracodeClient._request({ endPoint: "mytest.do" });
    const expectedUrl = new URL('mytest.do', veracodeClient.apiBase);
    expect(request).toBeCalledWith(baseRequestArg(expectedUrl, 'GET'));
    expect(response).toEqual({
      test: {
        _attributes: {
          account_id: "123",
          app_id: "456"
        },
        nested: {
          _attributes: {
            nested_id: "789"
          }
        }
      }
    });
  });

  test('throws error', async () => {
    request.mockResolvedValue('<error>Baby did a boom boom</error>');
    expect(veracodeClient._request({ endPoint: "mytest.do" })).rejects.toThrow("Baby did a boom boom");
  });
});

describe('#uploadFile', async () => {
  test('uploads file with all options', async () => {
    request.mockResolvedValue('<filelist><file/></filelist>');
    
    await veracodeClient.uploadFile({ appId: "123", file: "my_lil_file.zip", sandboxId: "456", saveAs: "my_lil_file" });
    expect(fs.createReadStream).toBeCalledWith("my_lil_file.zip");
    
    const expectedUrl = new URL('uploadfile.do', veracodeClient.apiBase);
    expect(request).toBeCalledWith({
      ...baseRequestArg(expectedUrl),
      formData: {
        app_id: "123",
        file: undefined,
        sandbox_id: "456",
        save_as: "my_lil_file"
      }
    });
  });

  test('doesn\'t include sandbox_id or save_as if not provided in options', async () => {
    request.mockResolvedValue('<filelist><file/></filelist>');
    
    await veracodeClient.uploadFile({ appId: "123", file: "my_lil_file.zip" });
    expect(fs.createReadStream).toBeCalledWith("my_lil_file.zip");
    
    const expectedUrl = new URL('uploadfile.do', veracodeClient.apiBase);
    expect(request).toBeCalledWith({
      ...baseRequestArg(expectedUrl),
      formData: {
        app_id: "123",
        file: undefined
      }
    });
  });
});

describe('#createZipArchive', async () => {
  let mockWriteStream = {
    registeredListeners: {},

    on: function (event, listener) {
      this.registeredListeners[event] = listener;
    },

    simulate: function (event, ...args) {
      this.registeredListeners[event](...args);
    },
  };

  let mockArchiver = {
    registeredListeners: {},

    on: function (event, listener) {
      this.registeredListeners[event] = listener;
    },

    simulate: function (event, ...args) {
      this.registeredListeners[event](...args);
    },

    pointer: jest.fn().mockReturnValue(420),
    pipe: jest.fn(),
    glob: jest.fn(),
    finalize: jest.fn(),
  };

  beforeAll(async () => {
    fs.createWriteStream.mockReturnValue(mockWriteStream);
    archiver.mockReturnValue(mockArchiver);
  });

  beforeEach(async () => {
    mockArchiver.registeredListeners = {};
    mockWriteStream.registeredListeners = {};
  });

  test('returns archive size', async done => {
    veracodeClient.createZipArchive('testdir', 'test', null).then((archiveSize) => {
      expect(archiveSize).toBe(420);
      done();
    });
    mockWriteStream.simulate('close');
  });

  test('rejects on fatal warning', async done => {
    veracodeClient.createZipArchive('testdir', 'test', null).catch((warning) => {
      expect(warning.code).toBe(1);
      done();
    });
    mockArchiver.simulate('warning', { code: 1 });
  });

  test('logs to console with non-fatal warnings', async done => {
    jest.spyOn(console, 'log').mockImplementationOnce(() => {});
    veracodeClient.createZipArchive('testdir', 'test', null).then(() => {
      done();
    });
    mockArchiver.simulate('warning', { code: 'ENOENT', message: 'do not do that plz' });
    mockWriteStream.simulate('close');
    expect(console.log).toHaveBeenCalledWith('Warning: do not do that plz');
  });

  test('rejects on archiver error', async done => {
    veracodeClient.createZipArchive('testdir', 'test', null).catch((error) => {
      expect(error).toEqual({ code: 'borked', message: 'it borked' });
      done();
    });
    mockArchiver.simulate('error', { code: 'borked', message: 'it borked' });
  });
});
