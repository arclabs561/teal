# teal

Teal.fm stack (fork): web app plus Rust services.

Licensed under MIT.

```bash
pnpm install
git submodule update --init --recursive

cp apps/aqua/.env.example apps/aqua/.env
./scripts/setup-sqlx.sh

turbo dev --filter=@teal/aqua
```

See `CONTRIBUTING.md` for development notes.
