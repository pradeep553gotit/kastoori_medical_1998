# Reference File Hashes (mine, right now)

These are the SHA-256 hashes of the exact style.css and app.js I have
after applying every fix so far (table touch-action fix + global
touch-action safety net). Compare these against what the badge/
diagnostics page shows on your phone -- if they match exactly, you are
provably running my code. If they don't match, you are provably not,
regardless of what Vercel's dashboard says.

style.css: 63206564231144a8967a7f3a6347e19c19df17d446563777292f8aca3322af61
app.js:    bf84b05362efc8149b3d32028cefbfa2fefd5ce422c3c4f4080a3c13ab89d5f4

(app.js hash will change once you add the <script> tags for build-badge.js
etc. to index.html -- that's expected and fine, since index.html isn't
part of this hash. Only compare the style.css hash strictly; for app.js
just confirm the badge loads and shows *a* hash rather than an error.)
