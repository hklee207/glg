// Usage: ANTHROPIC_API_KEY=sk-... npm run fetch -- "SK Hynix"
import { fetchValueChain } from "../server/valueChain.mjs";

const company = process.argv[2] || "SK Hynix";
const result = await fetchValueChain(company);
console.log(JSON.stringify(result, null, 2));
