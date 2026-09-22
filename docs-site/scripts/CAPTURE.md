# Authenticated screenshot capture

Set `AWSOPS_CAPTURE_URL` to the application URL and supply
`AWSOPS_LOGIN_EMAIL` and `AWSOPS_LOGIN_PASSWORD` privately in the process
environment. There is no default password. Remote connections verify TLS.

The normal application `/login` flow needs no extra URL setting. For the
Cognito Hosted UI fallback, also set `AWSOPS_CAPTURE_LOGIN_URL` to the exact
trusted login origin, for example `https://tenant.auth.example`.
Custom login domains use this same setting. An arbitrary Cognito domain is
not trusted merely because it belongs to Cognito.
Only one hosted-login origin is supported. Federated login chains that navigate
to additional identity-provider origins are intentionally blocked.

Credentials are filled only after the current page origin matches the
configured application or login origin. Completion requires returning to
the application origin. HTTP and login bypass are allowed only for exact
loopback hostnames (`localhost`, `127.0.0.1`, `[::1]`).

Capture failures exit with a nonzero status. The removed default password remains
in repository history: operators must rotate any account that used that value,
including a demo account if its password was reused. Source removal does not
establish that credential rotation has occurred.
