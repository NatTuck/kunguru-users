
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

## Deployment conventions

- If a deployment has both a gateway and a user server, then Hermes instances
run only on the *user* server.

## Deploying

- `git clone https://github.com/NatTuck/kunguru-users.git` as the kunguru user
on the machine where this should run. Everything we need to set things up
should be in that checkout except for the instance-specific config.

See notes/servers.md for the test instances.

## Project Scope

The scope of this project includes both developing and deploying the web app in
this repo and managing the test instances (see notes/servers.md), especially
including the Bifrost instances. The (secret free) Bifrost configs should
be tracked in this repo (at ./bifrost/{instance}).

Directly doing Bifrost config changes by editing config files or using the
API on the live test instances is in scope and expected.

Double check that we really have no secrets committed before pushing this
repo to a public git hosting service.
