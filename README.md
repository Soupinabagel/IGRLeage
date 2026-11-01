# Reel League

A Music League-style game for you and your friends, played with Instagram reels.

## How a round works

1. The admin (whoever creates the league) starts a round with a theme.
2. Everyone pastes one Instagram reel link. Submissions are anonymous. When every player in the league has submitted, voting opens automatically.
3. Each player gets 10 upvotes and 3 downvotes per round, can put any number of them on a single reel, and must spend all of them before their votes can be saved. You can't vote on your own reel.
4. When every player has saved their votes, the round closes automatically and shows the results: who submitted what, net points, comments, and the running leaderboard. A reel's score is its upvotes minus its downvotes.

The admin can still use the "start voting" and "reveal results" buttons to move a round along early, for example if someone has dropped out. A league needs at least 3 players for a round to work.

The vote budgets are set in `RULES` at the top of `server.js`.

## Run it locally

Requires Node 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000, start a league, then share the invite link (or the 6-character code) with friends.

## Hosting it for your friends

The app is one Node process with a SQLite file, so it needs a host with a persistent disk:

- **Fly.io or Railway:** attach a volume and set `DB_PATH` to a file on it (for example `/data/data.db`).
- **A small VPS:** run `npm start` under `pm2` or systemd, with a reverse proxy such as Caddy for HTTPS.
- **Not ideal:** hosts with ephemeral disks (Render's free tier, Heroku), since the database resets on restart.

Set `PORT` if your host needs a specific one.

## Notes

- Instagram's "Watch here" embed uses `/embed` on the reel URL. It works for public reels, but private accounts and some reels won't play. Every card also has an "Open on Instagram" link.
- Sign-in is a random token saved in the browser, with no passwords. That suits a friend group, but anyone with an invite code can join, so only share it with people you trust. Clearing browser data signs you out of that player.
- Data lives in `data.db`. Back it up by copying the file.

## Files

- `server.js`: API and game rules (Express + better-sqlite3)
- `public/index.html`: the whole frontend, no build step
