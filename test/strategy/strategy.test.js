'use strict';

const http = require('http');
const sinon = require('sinon');
const MockRequest = require('readable-mock-req');
const expect = require('chai').expect;
const Issuer = require('../../lib').Issuer;
const Strategy = require('../../lib').Strategy;

describe('OpenIDConnectStrategy', function () {
  before(function () {
    this.origIncomingMessage = http.IncomingMessage;
    http.IncomingMessage = MockRequest;
  });

  after(function () {
    http.IncomingMessage = this.origIncomingMessage;
  });

  beforeEach(function () {
    this.issuer = new Issuer({
      issuer: 'https://op.example.com',
      authorization_endpoint: 'https://op.example.com/auth',
      jwks_uri: 'https://op.example.com/jwks',
      token_endpoint: 'https://op.example.com/token',
      userinfo_endpoint: 'https://op.example.com/userinfo',
    });

    this.client = new this.issuer.Client({
      client_id: 'foo',
      client_secret: 'barbaz',
      respose_types: ['code'],
      redirect_uris: ['http://rp.example.com/cb'],
    });
  });

  describe('initate', function () {
    it('gets some defaults from client', function () {
      const strategy = new Strategy(this.client, () => {});
      expect(strategy).to.have.property('scope', 'openid');
      expect(strategy).to.have.property('response_type', 'code');
      expect(strategy).to.have.property('redirect_uri', 'http://rp.example.com/cb');
    });

    it('can be passed those', function () {
      const strategy = new Strategy({
        client: this.client,
        response_type: 'code id_token',
        redirect_uri: 'http://rp.example.com/callback',
        scope: ['openid', 'profile'],
      }, () => {});
      expect(strategy).to.have.property('scope', 'openid profile');
      expect(strategy).to.have.property('response_type', 'code id_token');
      expect(strategy).to.have.property('redirect_uri', 'http://rp.example.com/callback');
    });

    it('starts authentication requests for GETs', function () {
      const strategy = new Strategy(this.client, () => {});

      const req = new MockRequest('GET', '/login/oidc');
      req.session = {};

      strategy.redirect = sinon.spy();
      strategy.authenticate(req);

      expect(strategy.redirect.calledOnce).to.be.true;
      const target = strategy.redirect.firstCall.args[0];
      expect(target).to.include('redirect_uri=');
      expect(target).to.include('scope=');
      expect(target).to.include('nonce=');
      expect(target).to.include('state=');
      expect(req.session).to.have.property('oidc:op.example.com');
      expect(req.session['oidc:op.example.com']).to.have.keys('nonce', 'state');
    });

    it('starts authentication requests for POSTs', function () {
      const strategy = new Strategy(this.client, () => {});

      const req = new MockRequest('POST', '/login/oidc');
      req.session = {};
      req.body = {};

      strategy.redirect = sinon.spy();
      strategy.authenticate(req);

      expect(strategy.redirect.calledOnce).to.be.true;
      const target = strategy.redirect.firstCall.args[0];
      expect(target).to.include('redirect_uri=');
      expect(target).to.include('scope=');
      expect(target).to.include('nonce=');
      expect(target).to.include('state=');
      expect(req.session).to.have.property('oidc:op.example.com');
      expect(req.session['oidc:op.example.com']).to.have.keys('nonce', 'state');
    });
  });

  describe('callback', function () {
    it('triggers the verify function and then the success one', function (next) {
      const ts = { foo: 'bar' };
      sinon.stub(this.client, 'authorizationCallback', function () {
        return Promise.resolve(ts);
      });

      const strategy = new Strategy(this.client, (tokenset, done) => {
        expect(tokenset).to.equal(ts);
        done(null, tokenset);
      });

      strategy.success = () => { next(); };

      const req = new MockRequest('GET', '/login/oidc/callback?code=foobar&state=state');
      req.session = {
        nonce: 'nonce',
        state: 'state',
      };

      strategy.authenticate(req);
    });

    it('triggers the error function when server_error is encountered', function (next) {
      const strategy = new Strategy(this.client, () => {});

      const req = new MockRequest('GET', '/login/oidc/callback?error=server_error');
      req.session = {
        nonce: 'nonce',
        state: 'state',
      };

      strategy.error = (error) => {
        try {
          expect(error.error).to.equal('server_error');
          next();
        } catch (err) {
          next(err);
        }
      };

      strategy.authenticate(req);
    });

    it('triggers the error function when non oidc error is encountered', function (next) {
      const strategy = new Strategy(this.client, () => {});

      sinon.stub(this.client, 'authorizationCallback', function () {
        return Promise.reject(new Error('callback error'));
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=code');
      req.session = {
        nonce: 'nonce',
        state: 'state',
      };

      strategy.error = (error) => {
        try {
          expect(error.message).to.equal('callback error');
          next();
        } catch (err) {
          next(err);
        }
      };

      strategy.authenticate(req);
    });

    it('triggers the fail function when oidc error is encountered', function (next) {
      const strategy = new Strategy(this.client, () => {});

      const req = new MockRequest('GET', '/login/oidc/callback?error=login_required');
      req.session = {
        nonce: 'nonce',
        state: 'state',
      };

      strategy.fail = (error) => {
        try {
          expect(error.message).to.equal('login_required');
          next();
        } catch (err) {
          next(err);
        }
      };

      strategy.authenticate(req);
    });

    it('triggers the error function for errors during verify', function (next) {
      const strategy = new Strategy(this.client, (tokenset, done) => {
        done(new Error('user find error'));
      });

      const ts = { foo: 'bar' };
      sinon.stub(this.client, 'authorizationCallback', function () {
        return Promise.resolve(ts);
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=foo');
      req.session = {
        nonce: 'nonce',
        state: 'state',
      };

      strategy.error = (error) => {
        try {
          expect(error.message).to.equal('user find error');
          next();
        } catch (err) {
          next(err);
        }
      };

      strategy.authenticate(req);
    });

    it('triggers the fail function when verify yields no account', function (next) {
      const strategy = new Strategy(this.client, (tokenset, done) => {
        done();
      });

      const ts = { foo: 'bar' };
      sinon.stub(this.client, 'authorizationCallback', function () {
        return Promise.resolve(ts);
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=foo');
      req.session = {
        nonce: 'nonce',
        state: 'state',
      };

      strategy.fail = () => {
        next();
      };

      strategy.authenticate(req);
    });

    it('does userinfo request too if part of verify arity', function (next) {
      const strategy = new Strategy(this.client, (tokenset, userinfo, done) => {
        try {
          expect(tokenset).to.be.ok;
          expect(userinfo).to.be.ok;
          done(null, { sub: 'foobar' });
        } catch (err) {
          next(err);
        }
      });

      const ts = { foo: 'bar' };
      const ui = { sub: 'bar' };
      sinon.stub(this.client, 'authorizationCallback', function () {
        return Promise.resolve(ts);
      });
      sinon.stub(this.client, 'userinfo', function () {
        return Promise.resolve(ui);
      });

      const req = new MockRequest('GET', '/login/oidc/callback?code=foo');
      req.session = {
        nonce: 'nonce',
        state: 'state',
      };

      strategy.success = () => {
        next();
      };

      strategy.authenticate(req);
    });
  });
});
