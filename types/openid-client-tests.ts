import { IncomingMessage } from 'http';

// tslint:disable-next-line:no-relative-import-in-test
import { custom, generators, Issuer, Client, Strategy, StrategyVerifyCallback, StrategyOptions, TokenSet, RegisterOther, IssuerMetadata } from './index.d';

async (req: IncomingMessage) => {
    // Custom HTTP options on the `Issuer` _c'tor_ (e.g. used for `Issuer.discover()`):
    Issuer[custom.http_options] = options => {
        console.log(options.followRedirect, options.timeout, options.retry);
        return {
            ...options,
            followRedirect: true,
            timeout: 10_000,
            retry: 3,
        };
    };

    let issuer = await Issuer.discover('https://accounts.google.com');
    console.log('Discovered issuer %O', issuer.metadata.issuer);

    issuer.keystore();
    issuer.keystore(true);

    //
    issuer = new Issuer({
        issuer: 'https://accounts.google.com',
        authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        token_endpoint: 'https://oauth2.googleapis.com/token',
        userinfo_endpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
        revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
        jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    });

    issuer[custom.http_options] = options => ({ ...options, retry: 3 });

    //

    issuer.Client[custom.http_options] = options => ({ ...options, retry: 3 });

    const client = new issuer.Client({
        client_id: 'c',
        client_secret: 's',
        redirect_uris: ['http://localhost:3000/cb'],
        response_types: ['code'],
    });
    console.log(client.metadata.client_id);

    // Custom HTTP options on the `Client` _instance_
    client[custom.http_options] = options => ({ ...options, retry: 3 });
    client[custom.clock_tolerance] = 5;

    //

    const code_verifier = generators.codeVerifier();

    const code_challenge = generators.codeChallenge(code_verifier);

    //

    client
        .authorizationUrl({
            scope: 'openid email profile',
            response_mode: 'form_post',
            nonce: 'nonce',
            resource: 'https://my.api.example.com/resource/32178',
            code_challenge,
            code_challenge_method: 'S256',
        })
        .substring(0);

    //

    const params = client.callbackParams(req);
    const callbackResponse = await client.callback('https://client.example.com/callback', params, { code_verifier });
    console.log(callbackResponse.id_token, callbackResponse.access_token, callbackResponse.refresh_token);
    console.log(callbackResponse.expired(), callbackResponse.claims()['some claim name'], callbackResponse.claims().sub);

    //

    await client.userinfo('access token');
    const userinfo = await client.userinfo(callbackResponse);
    console.log(userinfo['some user info name']);

    //

    const grantResponse = await client.grant({
        grant_type: 'client_credentials',
        acr_values: 'acr_values',
    });
    console.log(grantResponse.access_token);

    //

    const introspectResponse = await client.introspect('token');
    const active: boolean = introspectResponse.active;
    console.log(introspectResponse['some claim name']);

    client.introspect('token', 'tokenTypeHint');

    client.introspect('token', 'tokenTypeHint', {});
    client.introspect('token', 'tokenTypeHint', { introspectBody: {} });

    //

    client.endSessionUrl({ id_token_hint: 'id_token_hint' }).substring(0);

    //

    await client.revoke('token', 'hint');
    client.revoke('token', 'hint', {});
    client.revoke('token', 'hint', { revokeBody: {}, clientAssertionPayload: {} });

    await client.refresh('token');
    await client.refresh('token', {});
    await client.refresh('token', { exchangeBody: {}, clientAssertionPayload: {} });

    // generics setup
    class CustomClient extends Client {
        myCustomMethod() { }

        static async register(metadata: object, other?: RegisterOther): Promise<CustomClient> {
            return new CustomClient({
                client_id: 'xxxx'
            });
        }
    }

    // generics: issuer

    class CustomIssuer extends Issuer<CustomClient> {
        constructor(metadata: IssuerMetadata) {
            super(metadata);
        }
    }

    const customIssuer = new CustomIssuer({
        issuer: 'test-issuer'
    });

    const customIssuedClient = new customIssuer.Client({
        client_id: 'c',
        client_secret: 's',
        redirect_uris: ['http://localhost:3000/cb'],
        response_types: ['code'],
    });

    customIssuedClient.myCustomMethod();

    // generics: strategy
    class PassportUser {
        tokenset: TokenSet;

        constructor(tokenset: TokenSet) {
            this.tokenset = tokenset;
        }

        getAccessToken() {
            return this.tokenset.access_token;
        }
    }

    const verify: StrategyVerifyCallback<PassportUser> = (tokenset, done) => {
        const user = new PassportUser(tokenset);
        const accessToken = user.getAccessToken();
        done(null, user);
    };

    class CustomStrategy extends Strategy<PassportUser, CustomClient> {
        client: CustomClient;

        constructor(options: StrategyOptions<CustomClient>, verify: StrategyVerifyCallback<PassportUser>) {
            super(options, verify);

            this.client = options.client;
        }

        authenticate() {
            this.client.myCustomMethod();
        }
    }

    const customClient = await CustomClient.register({});

    const strategyOptions = {
        client: customClient
    };

    strategyOptions.client.myCustomMethod();

    const customStrategy = new CustomStrategy(strategyOptions, verify);

    customStrategy.authenticate();
};
