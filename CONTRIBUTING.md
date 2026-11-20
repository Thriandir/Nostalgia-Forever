# Contributing

Contributions are welcome, from bug fixes to new views to whole integrations.

## Integrations live outside the core

Discord bots, WhatsApp bots, in-game addons and similar tools should be separate
programs that talk to the app through its API and webhooks, not code that lives
in this repo. If the API or an event you need is missing, open an issue or a PR
that adds it. See the roadmap in the README.

## Ground rules

- No framework and no build step in `web/`: plain ES modules.
- Every user-facing string goes into both `web/js/i18n/en.js` and `tr.js`, with identical keys.
- Every permission check happens on the server in `worker/worker.js`; the UI only hides things for convenience.
- Never commit secrets. Client IDs in `wrangler.toml` stay as placeholders.
- User-visible changes get an entry in `web/js/config/changelog.js`.

## Sign-off (DCO)

Add a `Signed-off-by` line to your commits (`git commit -s`). It certifies that you wrote the change,
or have the right to submit it, under the project's Apache-2.0 license
(see <https://developercertificate.org>).

## License

By contributing you agree that your contribution is licensed under Apache-2.0.
