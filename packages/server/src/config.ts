/** Runtime configuration, read from the environment with sane local defaults. */

/**
 * Port to listen on. PaaS platforms (Heroku, Render, Railway, Fly, …) inject
 * `PORT`; anything falsy — unset, empty string, or a non-numeric value — falls
 * back to the local default. `|| 2567` is deliberate over `?? 2567`: an empty
 * `PORT=""` parses to `0`, which would otherwise bind a random port.
 */
export const PORT = Number(process.env["PORT"]) || 2567;

/**
 * Interface to bind. Defaults to `0.0.0.0` so the server is reachable from
 * outside its container — a loopback-only bind is unroutable on every PaaS.
 */
export const HOST = process.env["HOST"] ?? "0.0.0.0";

/** Origin allowed to talk to this server; the Vite dev server by default. */
export const CLIENT_ORIGIN = process.env["CLIENT_ORIGIN"] ?? "http://localhost:5173";
