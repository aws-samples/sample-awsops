# Authenticated screenshot capture

Set `AWSOPS_CAPTURE_URL` to the application URL and supply
`AWSOPS_LOGIN_EMAIL` and `AWSOPS_LOGIN_PASSWORD` privately in the process
environment. There is no default password. Remote connections verify TLS.

The normal application `/login` flow needs no extra URL setting. For the
Cognito Hosted UI fallback, also set `AWSOPS_CAPTURE_LOGIN_URL` to the exact
trusted login origin, for example `https://tenant.auth.example`.
Custom login domains use this same setting. An arbitrary Cognito domain is
not trusted merely because it belongs to Cognito.

Credentials are filled only after the current page origin matches the
configured application or login origin. Completion requires returning to
the application origin. HTTP and login bypass are allowed only for exact
loopback hostnames (`localhost`, `127.0.0.1`, `[::1]`).
