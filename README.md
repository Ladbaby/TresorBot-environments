# TresorBot Environments

Environment adapters for [TresorBot](https://github.com/Ladbaby/TresorBot) Sun.

This repository is a catalogue, not a runtime. Each directory under
`environments/` is one environment adapter: a manifest and a JavaScript module.
Sun installs only the adapters you choose, from a release bundle, verified
against a digest you supply.

The environment host itself lives inside the TresorBot binary. You never clone
this repository to run Sun.

## What an environment is

An environment is a surface the bot interacts with, in **both directions**:

- **Inbound** — it turns something outside TresorBot into work: a chat message,
  a pull request, an email, a schedule tick, a webhook. It admits an **event**.
- **Outbound** — Sun sends the settled result back to the adapter, which posts it
  where it belongs.

That is why these are not called "inputs". A cron environment wakes a bot on a
schedule; the same environment is where a "schedule a job" tool would land once
tool exposure ships. Naming one side would have hidden the other.

Sun does everything between the two directions — decides which bot an event
belongs to, queues it, runs it, and hands the result back. That division is why
an adapter is small. It never touches the database, never decides which bot a
conversation belongs to, and never retries. It reads its source, calls `emit()`,
and tracks where it is through a cursor.

### Tools are designed but not implemented

An adapter may declare a `tools` capability. The intended contract is that Sun
asks for the adapter's tool list and routes a bot's tool call back to it, so a
bot can act on the environment rather than only receive from it. The wire shape
is agreed; nothing calls it yet. Do not rely on it in v1.

## Installing an environment

```bash
tresorbot-sun environment install \
  https://github.com/Ladbaby/TresorBot-environments/releases/download/v1.0.0/cron-1.0.0.json \
  --sha256 <digest>
```

`--sha256` is optional, as with `tresorbot-earth agent install`. Without it the
download is not checked against anything, so install reports the digest it
computed and marks the environment unverified.

```bash
tresorbot-sun environment list
tresorbot-sun environment remove cron
```

Environments land in `~/.tresorbot/environments/<name>/`. Take the digest from `digests.txt`

## Installing an environment

```bash
tresorbot-sun environment install \
  https://github.com/Ladbaby/TresorBot-environments/releases/download/v1.0.0/cron-1.0.0.json \
  --sha256 <digest>
```

`--sha256` is optional, as with `tresorbot-earth agent install`. Without it the
download is not checked against anything, so install reports the digest it
computed and marks the environment unverified.

```bash
tresorbot-sun environment list
tresorbot-sun environment remove cron
```

Inputs land in `~/.tresorbot/environments/<name>/`. Take the digest from `digests.txt`
on the release page, or from a source you trust: HTTPS alone does not establish
that the bytes are the environment you meant to install.

Removing an environment does not delete the instances that use it. Their settings and
cursors are your data, and an instance whose environment is missing is reported as
misconfigured rather than silently dropped; reinstalling makes it work again.

## Configuring an environment

Inputs are installed once and then **instantiated** any number of times. A
schedule environment might become `morning-brief` at 08:00 and `weekly-review` on
Friday afternoons; a webhook environment might become one instance per upstream.
Instances are created in Sun's dashboard, on the Inputs tab, because they need a
per-instance revision to keep two browser tabs from overwriting each other.

Sun passes settings only: `environment.json` declares what it accepts, Sun validates
and defaults them, and the adapter receives the result unchanged.

Supported types: `string`, `path`, `bool`, `int`, `string_list`, `enum`.

A setting marked `sensitive` is never stored as a value. Enter `env:NAME` in the
dashboard and Sun resolves it from its own environment at configuration time, so
a token exists only in the frame handed to the host — never in the database, a
log line, or the process table.

```yaml
# systemd, on the host running Sun
EnvironmentFile=/etc/tresorbot/sun.env
```
