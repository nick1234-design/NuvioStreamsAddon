# NuvioStreams

A configurable Stremio add-on that gathers direct streaming links from multiple provider integrations for movies and TV series.

<div align="center">

![Stremio](https://img.shields.io/badge/Stremio-Add--on-8c1c2c?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-8c1c2c?style=for-the-badge)

</div>

## Features

- Movie and TV-series stream results in Stremio
- Multiple provider integrations, with provider selection from the configuration page
- Per-provider minimum-quality preferences
- Optional codec exclusions for Dolby Vision and HDR formats
- Stream-link caching to reduce repeat lookups
- Optional Redis-backed caching
- Cookie, region, and ScraperAPI configuration options where supported by a provider
- Provider enable/disable switches for server administrators

Provider availability, link quality, playback compatibility, and response times depend on the third-party source and can change without notice. A provider may return no links for a particular title or episode.

## Provider integrations

The add-on is configured to expose only these six working providers:

| Provider | Notes |
| --- | --- |
| ShowBox | Main scraper; supports cookie and region configuration |
| 4KHDHub | Direct-link extraction |
| HDHub4u | Direct-link extraction |
| PlayIMDb | Direct-link extraction |
| Cinejoy | Stream links and subtitles when supplied |
| VAplayer | Stream links and subtitles when supplied |

Other legacy provider code remains in the repository for compatibility, but it is disabled and does not appear in stream results. Not every enabled provider is guaranteed to return results for every title.

## Installation

1. Open the configuration page for your deployed NuvioStreams instance.
2. Select the providers you want to use and adjust their quality preferences.
3. Configure any provider-specific options that you need.
4. Use the install button or copy the generated manifest link into Stremio.
5. Confirm the add-on installation in Stremio.

Keep your personal manifest URL private if it contains cookies or other provider configuration values.

## Self-hosting

### Requirements

- Node.js 18 or newer is recommended.
- A TMDB API key from [The Movie Database](https://www.themoviedb.org/settings/api).

### Run locally

```bash
git clone https://github.com/nick1234-design/NuvioStreamsAddon.git
cd NuvioStreamsAddon
npm install
```

Create a `.env` file in the project root:

```env
TMDB_API_KEY=your_tmdb_api_key_here
```

Start the server:

```bash
npm start
```

Open the local address printed by the server to access the configuration page.

### Deploying

The project is designed to run as a Node.js web service and includes support for Vercel deployment.

1. Import the repository into your hosting provider.
2. Configure the environment variables required by your setup.
3. Deploy the project.
4. Open the deployed configuration page and install the generated manifest in Stremio.

After changing environment variables in your hosting dashboard, redeploy so the running application receives the updated values.

## Environment variables

### Required

| Variable | Required | Purpose |
| --- | --- | --- |
| `TMDB_API_KEY` | Yes | Looks up title information and IMDb IDs used by provider integrations |

### Optional provider switches

Set a provider variable to `false` to disable that provider server-wide. If omitted, the corresponding switch defaults to enabled.

| Variable | Provider |
| --- | --- |
| `ENABLE_4KHDHUB_PROVIDER` | 4KHDHub |
| `ENABLE_HDHUB4U_PROVIDER` | HDHub4u |
| `ENABLE_PLAYIMDB_PROVIDER` | PlayIMDb |
| `ENABLE_CINEJOY_PROVIDER` | Cinejoy |
| `ENABLE_VAPLAYER_PROVIDER` | VAplayer |

Example:

```env
ENABLE_CINEJOY_PROVIDER=false
ENABLE_VAPLAYER_PROVIDER=false
```

### Optional caching and external services

| Variable | Purpose |
| --- | --- |
| `DISABLE_STREAM_CACHE=true` | Disables the add-on's stream cache; caching is enabled by default |
| `USE_REDIS_CACHE=true` | Enables the optional Redis cache |
| `REDIS_URL` | Redis connection URL; required when Redis caching is enabled |
| `USE_EXTERNAL_PROVIDERS=true` | Enables configured external provider services |
| `EXTERNAL_UHDMOVIES_URL` | External UHDMovies service base URL |
| `EXTERNAL_TOPMOVIES_URL` | External TopMovies service base URL |
| `EXTERNAL_MOVIESMOD_URL` | External MoviesMod service base URL |
| `GA_MEASUREMENT_ID` | Optional Google Analytics 4 measurement ID |
| `GA_API_SECRET` | Optional Google Analytics 4 Measurement Protocol secret |

Do not commit API keys, cookies, Redis credentials, or other secrets to the repository. Store them in your hosting provider's environment-variable settings.

## Project structure

```text
.
├── addon.js          # Add-on logic, provider orchestration, filtering and caching
├── server.js         # Express server, routes and request configuration
├── manifest.json     # Stremio add-on manifest
├── package.json      # Dependencies and start script
├── views/
│   └── index.html    # Configuration and installation page
├── providers/        # Provider integrations and extractors
└── nuvio-logo-256.png
```

## Adding or updating a provider

1. Add or update the provider implementation in `providers/`.
2. Export a function that returns an array of stream objects in the format expected by the add-on.
3. Register the provider in `addon.js`, including its enable switch and result handling.
4. Add or update its controls in `views/index.html`, if it should be configurable by users.
5. Test movie and episode lookups, stream playback, and the configuration page before deploying.

Use an existing provider integration as a reference so the new provider follows the project's stream format, error handling, and configuration conventions.

## Troubleshooting

| Problem | Things to check |
| --- | --- |
| A provider returns no results | The source site may be unavailable or may have changed. Check the server logs and try another provider. |
| A stream appears but will not play | The host may require headers, may block the player, or may have an expired link. Try another returned source. |
| The configuration page loads but installation fails | Confirm that the deployed service is reachable over HTTPS and that the manifest route is available. |
| Title lookups fail or return incomplete results | Check that `TMDB_API_KEY` is set correctly in the hosting environment. |
| A provider is missing | Check its server-side `ENABLE_*_PROVIDER` setting and the provider selection on the configuration page. |
| Changes do not appear after deployment | Check the deployment status and confirm that the latest commit was deployed. |

## Disclaimer

NuvioStreams does not host, store, or upload media. It retrieves and passes stream links from third-party sources to the user's player. Third-party sources may change, become unavailable, or provide content with different rights depending on location. Users are responsible for ensuring that their use complies with applicable laws and the terms of the services they access.

NuvioStreams is an independent project and is not affiliated with Stremio or the third-party providers listed above.

## Credits

This project is based on [tapframe/NuvioStreamsAddon](https://github.com/tapframe/NuvioStreamsAddon). Thanks to the original author and contributors for the foundation.
