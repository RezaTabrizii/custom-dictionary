import { createApp } from "../src/app.js";

// Starts the app on a free port. person(name) signs someone up (or in) and
// returns call(path, method, body), which sends their session cookie.
export async function startApp(options) {
  const server = createApp(options).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://localhost:${server.address().port}/api`;

  const request = async (path, { method = "GET", body, cookie = "", headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", cookie, ...headers },
      body: body && JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };

  async function person(username, password = "correct horse battery", code = options.signupCode) {
    let res = await request("/auth/signup", { method: "POST", body: { username, password, code } });
    // An existing account (or closed sign-up) signs in instead.
    if (res.status === 409 || res.status === 403) res = await request("/auth/login", { method: "POST", body: { username, password } });
    if (res.status >= 300) throw new Error(`Couldn't sign in ${username}: ${res.body?.error}`);
    const cookie = res.headers.get("set-cookie").split(";")[0];
    const call = async (path, method = "GET", body) => (await request(path, { method, body, cookie })).body;
    call.raw = (path, opts = {}) => request(path, { cookie, ...opts });
    return call;
  }

  return { base, request, person, close: () => server.close() };
}
