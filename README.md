# Dogsled Labs — Landing Page

The lab of Bobsled. A dark, vibrant landing page for Dogsled Labs' forward-deployed
agentic-transformation practice.

## Files

- `Dogsled-Labs-Landing.dc.html` — editable source (a Design Component). Open directly
  in a browser to view/edit.
- `support.js` — runtime required by the `.dc.html` source. Must sit next to it.
- `dist/index.html` — self-contained build. Fonts and runtime are inlined; works fully
  offline with no dependencies. This is the deployable file.

## View locally

Open `dist/index.html` in any browser — no server needed.

To work on the source, serve the folder (so `support.js` loads):

```bash
python3 -m http.server 8000
# then open http://localhost:8000/Dogsled-Labs-Landing.dc.html
```

## Deploy

Any static host (GitHub Pages, Netlify, Vercel, S3). `dist/index.html` is ready to serve as-is.

## Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit: Dogsled Labs landing page"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

## Sections

Hero · illustrative stats · deployment thesis (agents pull, people steer) · maturity
trail · engagement model · tools (data-source / workflow / human-agent interface
mapping) · principles · case studies · CTA · footer.
