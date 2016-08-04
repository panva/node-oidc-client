'use strict';

const util = require('util');
const assert = require('assert');
const jose = require('node-jose');
const uuid = require('node-uuid').v4;
const base64url = require('base64url');
const url = require('url');
const _ = require('lodash');
const got = require('got');

const gotErrorHandler = require('./got_error_handler');
const TokenSet = require('./token_set');
const tokenHash = require('./token_hash');
const OpenIdConnectError = require('./open_id_connect_error');

const CALLBACK_PROPERTIES = require('./consts').CALLBACK_PROPERTIES;
const CLIENT_METADATA = require('./consts').CLIENT_METADATA;
const CLIENT_DEFAULTS = require('./consts').CLIENT_DEFAULTS;
const JWT_CONTENT = require('./consts').JWT_CONTENT;

const map = new WeakMap();

function bearer(token) {
  return `Bearer ${token}`;
}

function instance(ctx) {
  if (!map.has(ctx)) map.set(ctx, {});
  return map.get(ctx);
}

class BaseClient {
  constructor(metadata, keystore) {
    _.forEach(_.defaults(_.pick(metadata, CLIENT_METADATA), CLIENT_DEFAULTS), (value, key) => {
      instance(this)[key] = value;
    });

    if (keystore !== undefined) {
      assert.ok(jose.JWK.isKeyStore(keystore), 'keystore must be an instance of jose.JWK.KeyStore');
      instance(this).keystore = keystore;
    }

    if (this.token_endpoint_auth_method.endsWith('_jwt')) {
      assert.ok(this.issuer.token_endpoint_auth_signing_alg_values_supported,
        'token_endpoint_auth_signing_alg_values_supported must be provided on the issuer');
    }
  }

  authorizationUrl(params) {
    assert.ok(typeof params === 'object', 'you must provide an object');

    const query = _.defaults(params, {
      client_id: this.client_id,
      scope: 'openid',
      response_type: 'code',
    });

    if (typeof query.claims === 'object') {
      query.claims = JSON.stringify(query.claims);
    }

    return url.format(_.defaults({
      search: null,
      query,
    }, url.parse(this.issuer.authorization_endpoint)));
  }

  authorizationCallback(redirectUri, parameters, checks) {
    const params = _.pick(parameters, CALLBACK_PROPERTIES);
    const toCheck = checks || {};

    if (params.error) {
      return Promise.reject(new OpenIdConnectError(params));
    }

    if (toCheck.state !== parameters.state) {
      return Promise.reject(new Error('state mismatch'));
    }

    let promise;

    if (params.id_token) {
      promise = Promise.resolve(new TokenSet(params))
        .then(tokenset => this.decryptIdToken(tokenset, 'id_token'))
        .then(tokenset => this.validateIdToken(tokenset, toCheck.nonce, 'id_token'));
    }

    if (params.code) {
      const grantCall = () => this.grant({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: redirectUri,
      })
        .then(tokenset => this.decryptIdToken(tokenset, 'id_token'))
        .then(tokenset => this.validateIdToken(tokenset, toCheck.nonce, 'id_token'));

      if (promise) {
        promise = promise.then(grantCall);
      } else {
        return grantCall();
      }
    }

    return promise;
  }

  decryptIdToken(token, use) {
    if (
      (use === 'userinfo' && !this.userinfo_encrypted_response_alg) ||
      (use === 'id_token' && !this.id_token_encrypted_response_alg)
    ) {
      return token;
    }

    let idToken = token;

    if (idToken instanceof TokenSet) {
      if (!idToken.id_token) {
        throw new Error('id_token not present in TokenSet');
      }

      idToken = idToken.id_token;
    }

    let expectedAlg;
    let expectedEnc;

    if (use === 'userinfo') {
      expectedAlg = this.userinfo_encrypted_response_alg;
      expectedEnc = this.userinfo_encrypted_response_enc;
    } else {
      expectedAlg = this.id_token_encrypted_response_alg;
      expectedEnc = this.id_token_encrypted_response_enc;
    }

    const header = idToken.split('.')[0];
    const headerObject = JSON.parse(base64url.decode(header));

    assert.equal(headerObject.alg, expectedAlg, 'unexpected alg used');
    assert.equal(headerObject.enc, expectedEnc, 'unexpected enc used');

    return jose.JWE.createDecrypt(this.keystore).decrypt(idToken).then(result => {
      if (token instanceof TokenSet) {
        token.id_token = result.payload.toString('utf8');
        return token;
      }
      return result.payload.toString('utf8');
    });
  }

  validateIdToken(token, nonce, use) {
    let idToken = token;
    let expectedAlg;

    if (use === 'userinfo') {
      expectedAlg = this.userinfo_signed_response_alg;
    } else {
      expectedAlg = this.id_token_signed_response_alg;
    }

    if (idToken instanceof TokenSet) {
      if (!idToken.id_token) {
        throw new Error('id_token not present in TokenSet');
      }

      idToken = idToken.id_token;
    }

    idToken = String(idToken);

    const now = Math.ceil(Date.now() / 1000);
    const parts = idToken.split('.');
    const header = parts[0];
    const payload = parts[1];
    const headerObject = JSON.parse(base64url.decode(header));
    const payloadObject = JSON.parse(base64url.decode(payload));

    const verifyPresence = prop => {
      if (payloadObject[prop] === undefined) {
        throw new Error(`missing required JWT property ${prop}`);
      }
    };

    assert.equal(headerObject.alg, expectedAlg, 'unexpected algorithm used');

    ['iss', 'sub', 'aud', 'exp', 'iat'].forEach(verifyPresence);
    assert.equal(this.issuer.issuer, payloadObject.iss, 'unexpected iss value');

    assert.ok(typeof payloadObject.iat === 'number', 'iat is not a number');
    assert.ok(payloadObject.iat <= now, 'id_token issued in the future');

    if (payloadObject.nbf !== undefined) {
      assert.ok(typeof payloadObject.nbf === 'number', 'nbf is not a number');
      assert.ok(payloadObject.nbf <= now, 'id_token not active yet');
    }

    if (payloadObject.nonce || (nonce !== undefined || nonce !== null)) {
      assert.equal(payloadObject.nonce, nonce, 'nonce mismatch');
    }

    assert.ok(typeof payloadObject.exp === 'number', 'exp is not a number');
    assert.ok(now < payloadObject.exp, 'id_token expired');

    if (payloadObject.azp !== undefined) {
      assert.equal(this.client_id, payloadObject.azp, 'azp must be the client_id');
    }

    if (!Array.isArray(payloadObject.aud)) {
      payloadObject.aud = [payloadObject.aud];
    } else if (payloadObject.aud.length > 1 && !payloadObject.azp) {
      throw new Error('missing required JWT property azp');
    }

    assert.ok(payloadObject.aud.indexOf(this.client_id) !== -1, 'aud is missing the client_id');

    if (payloadObject.at_hash) {
      assert.equal(payloadObject.at_hash, tokenHash(token.access_token, headerObject.alg),
        'at_hash mismatch');
    }

    if (payloadObject.c_hash) {
      assert.equal(payloadObject.c_hash, tokenHash(token.code, headerObject.alg),
        'c_hash mismatch');
    }

    if (headerObject.alg === 'none') {
      return Promise.resolve(token);
    }

    return (headerObject.alg.startsWith('HS') ? this.joseSecret() : this.issuer.key(headerObject))
      .then(key => jose.JWS.createVerify(key).verify(idToken))
      .then(() => token);
  }

  refresh(refreshToken) {
    let token = refreshToken;

    if (token instanceof TokenSet) {
      if (!token.refresh_token) {
        return Promise.reject(new Error('refresh_token not present in TokenSet'));
      }
      token = token.refresh_token;
    }

    return this.grant({
      grant_type: 'refresh_token',
      refresh_token: String(token),
    })
    .then(tokenset => this.decryptIdToken(tokenset, 'id_token'))
    .then(tokenset => this.validateIdToken(tokenset, undefined, 'id_token'));
  }

  userinfo(accessToken, options) {
    let token = accessToken;
    const opts = _.merge({
      verb: 'get',
      via: 'header',
    }, options);

    if (token instanceof TokenSet) {
      if (!token.access_token) {
        return Promise.reject(new Error('access_token not present in TokenSet'));
      }
      token = token.access_token;
    }

    const verb = String(opts.verb).toLowerCase();
    let httpOptions;

    switch (opts.via) {
      case 'query':
        assert.equal(verb, 'get', 'providers should only parse query strings for GET requests');
        httpOptions = { query: { access_token: token } };
        break;
      case 'body':
        assert.equal(verb, 'post', 'can only send body on POST');
        httpOptions = { body: { access_token: token } };
        break;
      default:
        httpOptions = { headers: { Authorization: bearer(token) } };
    }

    return got[verb](this.issuer.userinfo_endpoint, this.issuer.httpOptions(httpOptions))
      .then(response => {
        if (JWT_CONTENT.exec(response.headers['content-type'])) {
          return Promise.resolve(response.body)
            .then(jwt => this.decryptIdToken(jwt, 'userinfo'))
            .then(jwt => {
              if (!this.userinfo_signed_response_alg) return JSON.parse(jwt);
              return this.validateIdToken(jwt, null, 'userinfo')
                .then(valid => JSON.parse(base64url.decode(valid.split('.')[1])));
            });
        }

        return JSON.parse(response.body);
      }, gotErrorHandler);
  }

  joseSecret() {
    if (instance(this).jose_secret) {
      return Promise.resolve(instance(this).jose_secret);
    }

    return jose.JWK.asKey({
      k: base64url(new Buffer(this.client_secret)),
      kty: 'oct',
    }).then(key => {
      instance(this).jose_secret = key;
      return key;
    });
  }

  grant(body) {
    return this.authenticatedPost(this.issuer.token_endpoint, { body },
      response => new TokenSet(JSON.parse(response.body)));
  }

  revoke(token) {
    assert.ok(this.issuer.revocation_endpoint || this.issuer.token_revocation_endpoint,
      'issuer must be configured with revocation endpoint');
    const endpoint = this.issuer.revocation_endpoint || this.issuer.token_revocation_endpoint;
    return this.authenticatedPost(endpoint, { body: { token } },
      response => JSON.parse(response.body));
  }

  introspect(token) {
    assert.ok(this.issuer.introspection_endpoint || this.issuer.token_introspection_endpoint,
      'issuer must be configured with introspection endpoint');
    const endpoint = this.issuer.introspection_endpoint || this.issuer.token_introspection_endpoint;
    return this.authenticatedPost(endpoint, { body: { token } },
      response => JSON.parse(response.body));
  }

  /* eslint-disable no-underscore-dangle */
  fetchDistributedClaims(userinfo) {
    const distributedSources = _.pickBy(userinfo._claim_sources, def => !!def.endpoint);

    return Promise.all(_.map(distributedSources, (def, sourceName) => {
      const ext = def.access_token ?
        { headers: { Authorization: bearer(def.access_token) } } : undefined;
      return got.get(def.endpoint, this.issuer.httpOptions(ext)).then(response => {
        const data = JSON.parse(response.body);
        delete userinfo._claim_sources[sourceName];
        _.forEach(userinfo._claim_names, (inSource, claim) => {
          if (inSource === sourceName) {
            assert(data[claim] !== undefined, `expected claim "${claim}" in "${sourceName}"`);
            userinfo[claim] = data[claim];
            delete userinfo._claim_names[claim];
          }
        });
      }, gotErrorHandler).catch(err => {
        err.src = sourceName;
        throw err;
      });
    })).then(() => {
      if (_.isEmpty(userinfo._claim_names)) delete userinfo._claim_names;
      if (_.isEmpty(userinfo._claim_sources)) delete userinfo._claim_sources;
      return userinfo;
    });
  }

  unpackAggregatedClaims(userinfo) {
    // const aggregatedSources = _.pickBy(userinfo._claim_sources, def => !!def.JWT);
    return userinfo;
  }

  /* eslint-enable no-underscore-dangle */

  authenticatedPost(endpoint, httpOptions, success) {
    return Promise.resolve(this.grantAuth())
    .then(auth => got.post(endpoint, this.issuer.httpOptions(_.merge(httpOptions, auth)))
    .then(success, gotErrorHandler));
  }

  createSign() {
    let alg = this.token_endpoint_auth_signing_alg;
    switch (this.token_endpoint_auth_method) {
      case 'client_secret_jwt':
        return this.joseSecret().then(key => {
          if (!alg) {
            alg = _.find(this.issuer.token_endpoint_auth_signing_alg_values_supported,
              (signAlg) => key.algorithms('sign').indexOf(signAlg) !== -1);
          }

          return jose.JWS.createSign({
            fields: { alg, typ: 'JWT' },
            format: 'compact',
          }, { key, reference: false });
        });
      case 'private_key_jwt': {
        if (!alg) {
          const algz = _.uniq(_.flatten(_.map(this.keystore.all(), key => key.algorithms('sign'))));
          alg = _.find(this.issuer.token_endpoint_auth_signing_alg_values_supported,
            (signAlg) => algz.indexOf(signAlg) !== -1);
        }

        const key = this.keystore.get({ alg });
        assert.ok(key, 'no valid key found');

        return Promise.resolve(jose.JWS.createSign({
          fields: { alg, typ: 'JWT' },
          format: 'compact',
        }, { key, reference: true }));
      }
      /* istanbul ignore next */
      default:
        throw new Error('createSign only works for _jwt token auth methods');
    }
  }

  grantAuth() {
    switch (this.token_endpoint_auth_method) {
      case 'none' :
        throw new Error('client not supposed to use grant authz');
      case 'client_secret_post':
        return {
          body: {
            client_id: this.client_id,
            client_secret: this.client_secret,
          },
        };
      case 'private_key_jwt' :
      case 'client_secret_jwt' : {
        const now = Math.floor(Date.now() / 1000);
        return this.createSign().then(sign => sign.update(JSON.stringify({
          iat: now,
          exp: now + 60,
          jti: uuid(),
          iss: this.client_id,
          sub: this.client_id,
          aud: this.issuer.token_endpoint,
        })).final().then(client_assertion => { // eslint-disable-line camelcase, arrow-body-style
          return { body: {
            client_assertion,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          } };
        }));
      }
      default: {
        const value = new Buffer(`${this.client_id}:${this.client_secret}`).toString('base64');
        return { headers: { Authorization: `Basic ${value}` } };
      }
    }
  }

  inspect() {
    return util.format('Client <%s>', this.client_id);
  }

  static register(body, keystore) {
    assert.ok(this.issuer.registration_endpoint, 'issuer does not support dynamic registration');

    if (keystore !== undefined && !(body.jwks || body.jwks_uri)) {
      assert.ok(jose.JWK.isKeyStore(keystore), 'keystore must be an instance of jose.JWK.KeyStore');
      assert.ok(keystore.all().every(key => {
        if (key.kty === 'RSA' || key.kty === 'EC') {
          try { key.toPEM(true); } catch (err) { return false; }
          return true;
        }
        return false;
      }), 'keystore must only contain private EC or RSA keys');
      body.jwks = keystore.toJSON();
    }

    return got.post(this.issuer.registration_endpoint, this.issuer.httpOptions({
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    })).then(response => new this(JSON.parse(response.body), keystore), gotErrorHandler);
  }

  get keystore() {
    return instance(this).keystore;
  }

  get metadata() {
    return _.omitBy(_.pick(this, CLIENT_METADATA), _.isUndefined);
  }

  static fromUri(uri, token) {
    return got.get(uri, this.issuer.httpOptions({
      headers: { Authorization: bearer(token) },
    })).then(response => new this(JSON.parse(response.body)), gotErrorHandler);
  }
}

CLIENT_METADATA.forEach(prop => {
  Object.defineProperty(BaseClient.prototype, prop, {
    get() {
      return instance(this)[prop];
    },
  });
});

module.exports = BaseClient;
