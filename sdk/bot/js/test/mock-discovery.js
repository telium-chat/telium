// Test-only discovery transport for mocked globalThis.fetch fixtures. Production
// BotClient uses DNS-pinned HTTPS, bounded reads and redirect refusal instead.
async function fixtureResponse(url) {
  const response = await globalThis.fetch(url, { method: 'GET', redirect: 'error' });
  if (!response.ok) {
    const error = new Error('HTTP ' + response.status);
    error.status = response.status;
    throw error;
  }
  return response;
}
const getJson = async (url) => (await fixtureResponse(url)).json();
const getText = async (url) => (await fixtureResponse(url)).text();

export const discoveryTransport = {
  directGetJson: getJson,
  txtGetJson: getJson,
  txtGetText: getText,
};
