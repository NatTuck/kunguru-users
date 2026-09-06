
We're hosting individualized AI agents for people. Specifically, each user gets:

- A real system account on a Linux server.
- A Hermes Agent instance running on that account.
  - https://hermes-agent.nousresearch.com/
- A xmpp account through a Snikket server.
- Standard ways to interact with Hermes:
  - Hermes WebUI - https://github.com/nesquena/hermes-webui
  - Hermes XMPP Plugin - https://github.com/fastfinge/hermes-xmpp-plugin
  - Ntfy through ntfy.sh with a random topic

We need to build an app that manages our user accounts and can setup,
teardown, export, and import the above.

- A deployment may be to one or more servers.
- We use a https://docs.getbifrost.ai/ gateway to configure LLM providers,
provide LLM access for the Hermes agents, track usage by user, and possibly
enforce quotas. Optimally, we want to do model renaming here so we can
transparently switch models at least for the hosted version.

With multiple servers, some servers will have specific roles (possibly
overlapping):

- An admin server is where the user management app runs.
- A gateway server is on the public internet (probably its a VPS) and exposes
stuff on the public internet:
  - This is where the XMPP server likely runs.
  - The gateway is connected to the rest of the servers over a VPN (probably
    wireguard).
  - This forwards external requests that need to go to other servers (e.g.
  hermes-webui requests)
- User servers:
  - These run per-user stuff.

Configs that we want to have work:

- One public server (e.g. a VPS or rented dedicated server)
- A public gateway + one or more private servers (on residential / business
links, VPNed to the gateway).
- LLMs either locally, from one or more cloud providers, or a mix

Test setup:

- Gateway: otter.ferrus.net 
- Private server for user accounts: goose
- Can ssh from vampire to nat@ either.
