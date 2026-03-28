import { tokenize } from "./lexer";
import { parse } from "./parser";

const query = `
SELECT
  u.id,
  u.email,
  COALESCE(p.display_name, u.email) AS name,
  COUNT(o.id) AS order_count,
  SUM(o.total_cents) / 100.0 AS revenue
FROM users AS u
LEFT JOIN profiles p ON p.user_id = u.id AND p.deleted_at IS NULL
INNER JOIN (
  SELECT user_id, id, total_cents, created_at
  FROM orders
  WHERE status IN ('paid', 'shipped')
    AND created_at >= '2024-01-01'
) AS o ON o.user_id = u.id
WHERE u.age > 18
GROUP BY u.id, u.email, p.display_name
HAVING COUNT(o.id) >= 0
ORDER BY revenue ASC
LIMIT 100 OFFSET 20`;

const tokens = tokenize(query);
if (!tokens.ok) {
    console.error(tokens.diagnostics[0]?.message);
    process.exit(1);
}

const parsed = parse(tokens.value);
if (!parsed.ok) {
    console.error(parsed.diagnostics[0]?.message);
    process.exit(1);
}

console.dir(parsed.value, { depth: null });