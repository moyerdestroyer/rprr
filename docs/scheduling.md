# Local scheduling

`rprr poll` makes one pass and exits. It uses the authenticated `gh` user and can publish a `COMMENT` review for each direct review request. Finish `rprr init`, verify `rprr doctor`, and run `rprr poll` once manually before scheduling it. Check `rprr status` afterward. The poll needs `review.publish: true` in the config.

## systemd user timer (Linux)

The example units run the linked CLI every 15 minutes. Install them for your user:

```bash
bun link
test -x "$HOME/.bun/bin/rprr"
mkdir -p "$HOME/.config/systemd/user"
cp examples/systemd/rprr.service examples/systemd/rprr.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now rprr.timer
systemctl --user list-timers rprr.timer
```

The service sets a path that includes Bun, common user binaries, and system binaries. Add the directory containing your ACP agent if it lives elsewhere. The service uses your normal XDG config and state locations; if you set `XDG_CONFIG_HOME` or `XDG_STATE_HOME` in your shell, set the same values in the service unit. User services may have a different environment from your terminal, so test the service directly:

```bash
systemctl --user start rprr.service
systemctl --user status rprr.service
journalctl --user -u rprr.service -n 50 --no-pager
rprr status
```

`Persistent=true` triggers a catch-up run when an inactive timer starts after a missed scheduled time. The user manager normally runs while you have a login session; if you need polling while logged out, enable lingering for your account with `loginctl enable-linger "$USER"`. To stop polling:

```bash
systemctl --user disable --now rprr.timer
```

The service is one-shot, so systemd does not launch a second instance of the same service while it is already running. An agent review can take longer than the 15-minute interval; adjust the timer if that is common.

## cron alternative

Use cron if you do not have a systemd user manager. Edit your user crontab with `crontab -e` and add the following, replacing `/home/YOU` with your absolute home path and adding your agent's executable directory to `PATH` if needed:

```crontab
PATH=/home/YOU/.bun/bin:/home/YOU/.local/bin:/usr/local/bin:/usr/bin:/bin
*/15 * * * * /usr/bin/flock -n /home/YOU/.local/state/rprr/poll.lock /home/YOU/.bun/bin/rprr poll >> /home/YOU/.local/state/rprr/poll.log 2>&1
```

`flock` skips a run if the previous one is still active. The state directory is created by `rprr init`; adjust both paths if you use a custom `XDG_STATE_HOME`. Cron does not catch up missed runs while the machine is off. Inspect the log and `rprr status` after the first scheduled run. Remove the crontab line to stop polling.

References: [systemd timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html), [systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [crontab format](https://man7.org/linux/man-pages/man5/crontab.5.html).
