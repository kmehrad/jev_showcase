# Jev showcase

1. Open https://console.typesafe.ai/ and obtain an API key from the dashboard.
2. Copy `.env.example` to `.env` and replace the placeholder key.
3. Install uv: https://docs.astral.sh/uv/getting-started/installation/
4. Run `uv sync` from this folder.
5. Run `uv run jupyter lab` and open `jev_showcase.ipynb` with the project Python kernel.

The notebook explains all setup steps, Noul/Choice/Score, model discovery, probability plots, routing, and error handling. API examples are live and may incur charges. There are no recorded API predictions. Keep `.env` private.

The first sync generates `uv.lock` if none is included; retain it and use `uv sync --locked` for later reproduction.
