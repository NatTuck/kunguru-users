
This is a vite + vite-express + react + zustand app 

It's designed to be deployed to users.mydomain.com for a Kunguru hermes cluster
hosted at mydomain.com

It provides both user management and user authentication.

## Conventions

- react-router is used **only for routing/navigation** (URL <-> view mapping). It is
  NOT used for data or state management. All application state (auth/session, users,
  server data) lives in zustand stores under `client/*Store.ts`.
- Server data access for the API lives behind the `server/db.ts` schema/helpers and the
  `server/routes.ts` express router.

## Deploying

- `git clone https://github.com/NatTuck/kunguru-users.git` as the kunguru user
on the machine where this should run. Everything we need to set things up
should be in that checkout except for the instance-specific config.
