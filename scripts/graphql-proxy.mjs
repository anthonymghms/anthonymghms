import http from "node:http";

const API = "https://api.github.com/graphql";
const { BASE_TOKEN, ORG_TOKEN, ORG_IDS = "", ORG_LOGINS = "", PORT = "8787" } = process.env;
const orgIds = ORG_IDS.split(",").filter(Boolean);
const orgLogins = ORG_LOGINS.split(",").filter(Boolean).map((login) => login.toLowerCase());

const graphql = async (token, query, variables = {}) => {
  const response = await fetch(API, {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
};

const contributionsQuery = (args) => `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection${args ? `(${args})` : ""} {
        commitContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner primaryLanguage { name color } }
          contributions { totalCount }
        }
      }
    }
  }`;

const byRepository = (result) =>
  result?.data?.user?.contributionsCollection?.commitContributionsByRepository ?? [];

const languageContributions = async (args, login) => {
  const extraArgs = args ? `${args}, ` : "";
  const fromOrgs = await Promise.all(
    orgIds.map((id) => graphql(ORG_TOKEN, contributionsQuery(`${extraArgs}organizationID: "${id}"`), { login })),
  );
  if (fromOrgs.some((result) => result.errors)) throw new Error(JSON.stringify(fromOrgs.map((r) => r.errors)));

  const outsideOrgs = byRepository(await graphql(BASE_TOKEN, contributionsQuery(args), { login })).filter(
    ({ repository }) => !orgLogins.includes(repository.nameWithOwner.split("/")[0].toLowerCase()),
  );

  return [...fromOrgs.flatMap(byRepository), ...outsideOrgs].filter(({ repository }) => repository.primaryLanguage);
};

http
  .createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { query, variables } = JSON.parse(body);
    const result = await graphql(BASE_TOKEN, query, variables);
    const collection = result?.data?.user?.contributionsCollection;

    if (collection?.commitContributionsByRepository) {
      const args = query.match(/contributionsCollection\s*\(([^)]*)\)/)?.[1] ?? "";
      try {
        collection.commitContributionsByRepository = await languageContributions(args, variables.login);
      } catch (error) {
        console.error(`language lookup failed, keeping default data: ${error.message}`);
        collection.commitContributionsByRepository = collection.commitContributionsByRepository.filter(
          ({ repository }) => repository.primaryLanguage,
        );
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  })
  .listen(Number(PORT));
