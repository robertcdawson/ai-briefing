import { fetchAll } from "../src/fetch.js";

const articles = await fetchAll();

if (articles.length < 1) {
  console.error(JSON.stringify({ phase: "smoke", status: "fail", reason: "no articles returned from any source" }));
  process.exit(1);
}

console.error(JSON.stringify({ phase: "smoke", status: "pass", articles: articles.length }));
