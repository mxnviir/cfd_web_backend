# Design Rules: No AI Slop

This file is the single source of truth for how the website must look, read, and behave.
Every page, component, and line of copy is checked against it. If something here conflicts
with a "modern" default, this file wins.

The goal is simple. A visitor should never think "I have seen this exact site before."
The site should look like this product, not like the average of every SaaS page an AI model
has seen.

---

## 1. Hard bans

These are not suggestions. If any of these appear, the work is rejected.

### 1.1 Color

- No purple gradients. No purple and black theme.
- No harsh gradients of any kind. No mesh gradients. No animated gradients.
- No gradient text in headlines.
- No rainbow coloring. No multi-colored icon sets where each icon gets its own hue.
- No neon colors.
- No basic pastel palettes (mint, lavender, baby blue, peach as the main colors).
- No pure white (#FFFFFF) page background. Use an off-white or a deliberate tinted ground.
- No glowing blobs, blurred orbs, or radial "orb" backgrounds behind the hero.
- No colored stripe on one side of cards, alerts, pricing tiers, or testimonials.
- No blue tinted icons in a light square or circle sitting beside text.
- One accent color. It is used for one job: the primary action and meaningful status. Nothing else.

### 1.2 Shape and surface

- No pill-shaped buttons. Buttons are rectangles with sharp or very small radius.
- No indicator pill above the hero (the small "Now in beta" or "New: v2" capsule with a dot).
- No pill badges as decoration. No eyebrow badges above section headings.
- No soft default corner radius on everything (the 12px to 24px rounded card look). Pick one small radius or none and use it everywhere.
- No drop shadow on everything. Shadows are for things that actually float (menus, dialogs).
- No liquid glass or glassmorphism. No backdrop blur panels. No frosted nav bars.
- No cards inside cards. One container level per section, at most.
- No dot grid backgrounds. No graph paper backgrounds. No noise texture overlays.
- No bento grids or "pencil grid" tile layouts where every tile is an equal decorated box.
- No fake terminal windows. No fake macOS browser frame with three dots.
- No 1px border plus hover lift card pattern.

### 1.3 Layout

- The hero is never centered. Text is not centered. The call to action is not centered under centered text.
- No three feature cards in a row.
- No repeated section rhythm: heading, gray subtitle, grid of equal boxes, repeat.
- No logo row or logo marquee unless every logo is a real paying customer who agreed to appear.
- No "Ready to get started?" gradient box before the footer.
- No numbered steps with big faded "01 02 03" numbers.
- No sections where every element has the same visual weight. One thing per section dominates.
- No identical max-width centered container for every section. Vary the structure with intent.
- No bottom-right chat bubble, exit popups, or countdown timers.

### 1.4 Typography

- Do not use Inter.
- Do not use Space Grotesk, or any of the "grotesque" or "gothic" family fonts commonly used as AI defaults (Cabinet Grotesk, Neue Montreal style knockoffs, blackletter gothic).
- Also avoid these because they are now AI defaults: DM Sans, Manrope, Plus Jakarta Sans, Poppins, Outfit, Geist, Satoshi.
- Pick one text face and, if needed, one heading face. Two families maximum.
- Define a real hierarchy: one H1 style, one H2 style, one body size that is readable, one caption style. Fewer weights.
- No thin (100 to 300) weights for body text. No low contrast gray-on-white body text.
- No title case on every heading. No two-word headings with a period ("Built different.").

### 1.5 Icons and imagery

- No emojis anywhere in the UI or copy.
- No emoji used as icons.
- No sparkle icons. No "AI" sparkle marks.
- No animated arrows. No arrow glyph appended to every button label.
- No icon grid where six identical icon boxes stand in for product evidence.
- No AI generated stock photos. No AI generated illustrations. No undraw or storyset style vector people.
- No placeholder avatars (pravatar, dicebear, randomuser, unsplash faces).
- Real product screenshots, real outputs, real charts from the actual product only.

### 1.6 Motion

- No over-the-top scroll animations. No parallax. No word-by-word text reveal on scroll.
- No cursor animations, custom cursors, or cursor trails.
- No hover animation on everything. Hover changes are limited to real interactive elements and are subtle.
- No pulsing dots, flashing status indicators, shimmer buttons, or animated borders.
- No typewriter headline effect.
- No staggered fade-in of every element on page load.
- Motion is allowed only when it shows state: a job is running, a result arrived, an error appeared.

### 1.7 Copy

- No em dashes. Use a comma, a period, or a colon.
- No vague hero text. The H1 says what the product does in concrete words.
- No "It's not X, it's Y" sentence pattern.
- No check mark bullet lists as a marketing device.
- No tricolon slogans ("Fast. Simple. Secure.").
- No "Meet X", "Introducing X", "Say hello to X" headings.
- No "Everything you need to...", "Built for...", "Designed for...", "Powerful features for..." heading templates.
- No AI stock copy. Banned words and phrases:
  seamless, effortless, effortlessly, supercharge, unlock, streamline, empower, elevate, leverage,
  robust, cutting-edge, next-gen, next generation, revolutionize, game-changer, in minutes, at scale,
  10x, blazing fast, lightning fast, powered by AI, AI-powered, reimagined, all-in-one, end-to-end,
  world-class, best-in-class, frictionless, intuitive, delightful, magical, transform your workflow,
  built for modern teams, ship with confidence, focus on what matters, actionable insights.
- No "Powered by AI" or "Made with AI" text anywhere.
- No lorem ipsum, TODO, or placeholder text in any build that leaves the local machine.
- Rule of thumb: if the sentence could describe 500 other products, rewrite it.

### 1.8 Fake evidence

- No fake reviews or testimonials. No big testimonial sections at all unless they are real, named, and verifiable.
- No fake metrics ("99.9% uptime", "10x faster", "50ms latency") without a real measurement behind them.
- No fake customer counters ("Trusted by 10,000+ teams"). No live counters ("34 people viewing now").
- No fake activity feeds, fake dashboards, or fake charts.
- If there is no real proof yet, say less and show the product doing the job.

### 1.9 Pricing

- No three pricing tiers laid out as three equal cards with a highlighted middle one.
- Show pricing as a plain table or a single clear offer. If there are tiers, the layout must not be the default three-column pattern.

### 1.10 Tooling

- Do not use Tailwind. Write plain CSS (or CSS modules / SCSS). Design tokens live in CSS custom properties.
- Do not paste in unmodified component library patterns (shadcn, Magic UI, Aceternity, Framer templates).
- No border-beam, shimmer, spotlight, meteors, or similar decorative component imports.

---

## 2. Additional signals that make a site look vibe coded

These are the things I see most often in AI output that are not in the list above. They are
banned too.

### 2.1 Structure

- The default page order used without thought: hero, logo row, six features, how it works, testimonials, pricing, FAQ, CTA box, footer.
- The default nav: logo left, "Features Pricing Docs Blog" center, "Sign in" and a filled "Get started" button right.
- The default footer: four columns of links, a copyright line, "Made with love".
- Twin CTA buttons in the hero: filled "Get started" plus outlined "Learn more".
- A "How it works" section with three icons and one sentence each. Show the actual flow instead.
- An FAQ accordion with generic questions ("Is there a free trial?", "Can I cancel anytime?").
- A dark hero with light beams, spotlight cones, or a grid fading into black.
- Empty states that show an illustration and "Nothing here yet".
- Modal dialogs for simple confirms. Toast notifications for everything.

### 2.2 Visual

- Every section padded the same large amount top and bottom, so the page feels like a long scroll of identical blocks.
- Cards with borders slightly lighter than the background in dark mode (the "white at 10 percent" border).
- Section labels in small uppercase letter-spaced text above every heading.
- Sentence case heading followed by a gray subtitle, repeated for every section.
- Icons sitting in a tinted circle.
- Same button size and style everywhere, so primary and secondary actions look equal.
- No real images at all, only icons and shapes.
- Huge empty whitespace with a single sentence in it, used to feel "premium".
- Color used for decoration rather than meaning. Color should mark status, severity, or category.

### 2.3 Copy and naming

- Feature names built as Noun + "Engine", "Hub", "Studio", "Copilot", "Cloud".
- Headlines that could be swapped between an analytics tool, a CRM, and a design tool without edits.
- A headline that names a benefit ("Move faster") instead of a behavior ("Run the mesh check before you submit the job").
- Subheadings that restate the headline in softer words.
- "Learn more" links everywhere instead of links that say where they go.
- Body copy that avoids nouns. Real copy names the input, the output, and the step in between.

### 2.4 Shipping defaults that leak through

- Page title left as "Vite + React", "Create Next App", or the framework name.
- Default framework favicon (vite.svg, next.svg, react logo).
- Default 404 page.
- Links that go to "#". Social links that go nowhere.
- Missing meta description, missing Open Graph image, missing canonical URL.
- Console errors on load. Horizontal scroll on mobile.
- Missing image alt text. Icon-only buttons with no label. No visible focus state on keyboard navigation.
- Wrong copyright year. Hardcoded "Last updated" dates.
- Forms with no error messages, or errors that only say "Something went wrong".
- Missing or blank loading states. A blank screen or a lonely spinner while data loads is not acceptable. Loading states must exist and must match the shape of the content that is coming.

### 2.5 Things that make a site useless, not just ugly

- The page cannot answer these in the first screen: What does this do? Who is it for? What do I put in? What do I get back? What happens next? Why should I trust the result?
- No visible product workflow. Benefits are listed but the actual steps are never shown.
- No real product demo. A screenshot of the real thing beats any illustration. A working input on the landing page beats a screenshot.
- The design carries the page. If you removed all color and decoration and the page no longer explains the product, the copy and structure are broken.

---

## 3. What to do instead

### 3.1 Hero patterns (never centered)

Pick one:

1. Left-aligned text block, product screenshot on the right bleeding off the edge.
2. Editorial: large heading top-left, one short paragraph, then the real product image full width below.
3. Split screen: left half is the pitch, right half is the working product (a real input the visitor can use).
4. Asymmetric two column: heading in the narrow left column, the real output (report, plot, result) in the wide right column.
5. Top-aligned heading with a horizontal rule, then a two column body: what it does on the left, a real example on the right.

The hero must contain real product evidence. Not an abstract shape.

### 3.2 Sections

- One dominant element per section. The rest supports it.
- Show one real workflow instead of six abstract benefits.
- Remove one wrapper layer from every section before shipping.
- Vary structure between sections: a table, then a full-bleed image, then a two column text block. Not the same grid three times.

### 3.3 Copy

- Write the H1 as: what it does, for whom, on what input. Example shape: "Check your [input] for [specific problem] before [the moment it matters]."
- Use specific verbs: checks, generates, blocks, fixes, scans, sends, imports, exports, compares, warns.
- Name the input and the output in every feature description.
- Read only the H2s out loud. If they could belong to any product, rewrite them.

### 3.4 Color and type

- Ground: off-white or a deliberate dark, not pure white or pure black.
- Text: near-black, not gray, for body.
- One accent for primary actions and meaningful status only.
- Type: two families at most, three weights at most, a clear size step between H1, H2, body, and caption.
- Radius: one value, small, everywhere. Or none.

### 3.5 Light mode is designed, not inverted

A light theme is never produced by flipping the dark palette. Inverted themes look washed out,
the accent stops working, and shadows and borders end up in the wrong places. Build the light
mode as its own design that follows every rule in this file.

- Ground: a warm or cool off-white chosen on purpose, not #FFFFFF and not the dark background inverted.
- Text: near-black for body, one darker step for headings. Not gray.
- Accent: re-pick it for light backgrounds. The same hex that reads well on dark is often too bright or too weak on light. Check contrast on both themes separately.
- Surfaces: on light, separation comes from a slightly darker or slightly lighter panel tone and a thin border, not from shadow. On dark, separation comes from tone steps, not from light borders.
- Borders: light mode borders are a real darker gray. Do not carry over the "white at 10 percent" dark mode border.
- Status colors (error, warning, success, running): choose a light-mode set and a dark-mode set. Do not reuse one set for both.
- Images and screenshots: product screenshots must match the theme they sit in. Do not show a dark app screenshot on a light page or the reverse.
- Focus rings, selection color, and links get their own light values.
- Test both themes side by side at the same scroll position. Both must look finished. If one looks like an afterthought, it is not done.
- Tokens: define two full sets of CSS custom properties (one per theme). Every color in the codebase comes from a token. No hardcoded hex in components.

### 3.6 Evidence

- Real screenshots of the real product.
- Real example output (a report, a result table, a plot from an actual run).
- A before and after from a real case.
- A real checklist the product actually runs.
- If none of these exist yet, ship without a proof section. Do not fake one.

---

## 4. Launch gates

The site does not go live until every line here is done. No exceptions.

- [ ] Custom domain connected and serving over HTTPS.
- [ ] Favicon added (real brand mark, not the framework default). Includes the 32px, 180px Apple touch, and SVG variants.
- [ ] "Made with AI", "Built with [tool]", and any platform watermark or badge removed.
- [ ] Privacy policy page exists, is linked in the footer, and reflects what the site actually collects.
- [ ] Terms and conditions page exists and is linked in the footer.
- [ ] Page title, meta description, and Open Graph image set on every public page.
- [ ] No placeholder text, no "#" links, no console errors, no horizontal scroll on mobile.
- [ ] Every image has alt text. Every icon-only control has a label. Keyboard focus is visible.
- [ ] No Tailwind in the codebase.
- [ ] Every item in Section 1 and Section 2 has been checked against the final build.

---

## 5. Review checklist (run on every page before merge)

Answer each honestly.

1. Is the hero off-center, and does it show real product output?
2. Count the wrappers in each section. Can one be removed?
3. Is there exactly one accent color, and is it only on actions and status?
4. Are there any pills, badges, glows, gradients, orbs, blurs, or glass surfaces? Remove them.
5. Read every heading alone. Could it be on another product's site? Rewrite it.
6. Search the copy for the banned word list. Search for em dashes. Search for emojis.
7. Are there three equal cards anywhere? Break the pattern.
8. Is every number on the page backed by a real measurement?
9. Is every testimonial, logo, and customer count real and permitted?
10. Does anything move that is not showing state?
11. Is the font Inter, Space Grotesk, or one of the other listed defaults? Change it.
12. Can a first-time visitor say what the product does, what to enter, and what they get back, using only the first screen?
13. Put light and dark side by side. Was light mode designed on its own, or is it an inverted dark palette? Do accent, borders, status colors, and screenshots each have their own light values?

---

## 6. The prompt

Paste this at the top of any design or coding request, in any tool. Replace the bracketed parts.

```
You are designing and building [PAGE OR COMPONENT] for [PRODUCT], which [ONE SENTENCE: what it does, for whom, on what input, producing what output].

Your job is to make it look like this specific product and not like a default AI generated SaaS page. Follow every rule below. If a rule conflicts with a common "modern" default, the rule wins. Do not explain the rules back to me. Do not add anything I did not ask for.

TOOLING
- Plain CSS with custom properties for tokens. No Tailwind. No utility class frameworks.
- No unmodified component library patterns. No decorative component imports (border beams, shimmer, spotlight, meteors).

LAYOUT
- The hero is never centered. Use a left-aligned or split or editorial layout. The hero must show real product evidence, not an abstract graphic.
- Never place three feature cards in a row. Never use bento or tile grids of equal decorated boxes.
- One dominant element per section. Vary the structure between sections. Do not repeat heading, subtitle, grid.
- No cards inside cards. At most one container level per section.
- No default page skeleton (hero, logo row, six features, how it works, testimonials, pricing, FAQ, CTA box).
- No "Ready to get started?" box. No numbered 01 02 03 steps. No twin "Get started / Learn more" buttons.

COLOR AND SURFACE
- Ground is off-white or a deliberate dark. Never pure white. Never purple and black.
- One accent color, used only for the primary action and meaningful status.
- No gradients, no gradient text, no mesh or animated gradients, no glowing blobs or orbs, no neon, no rainbow icon coloring, no pastel palettes.
- No glassmorphism, no backdrop blur, no liquid glass.
- No drop shadows except on elements that truly float (menus, dialogs).
- No dot grids, no noise textures, no light beams, no spotlight effects.
- No colored stripe on one edge of a card. No blue tinted icon squares beside text.
- If both themes are required, design the light mode on its own. Never invert the dark palette. Light mode gets its own off-white ground, its own near-black text, its own accent value checked for contrast on light, real darker-gray borders instead of shadows, its own status colors, and screenshots that match the theme. Define one full token set per theme in CSS custom properties. Both themes must look equally finished.

SHAPE
- No pill buttons. No pill badges. No indicator pill above the hero. No eyebrow labels above headings.
- One small corner radius everywhere, or none. No soft rounded-card look.
- No fake terminal windows or fake browser frames.

TYPOGRAPHY
- Do not use Inter, Space Grotesk, DM Sans, Manrope, Plus Jakarta Sans, Poppins, Outfit, Geist, Satoshi, or any grotesque or gothic style default.
- Two families maximum, three weights maximum. Clear size steps between H1, H2, body, caption.
- Body text is near-black at a readable size. No thin weights. No low contrast gray body text.
- No title case on every heading. No two-word headings ending in a period.

ICONS, IMAGES, MOTION
- No emojis. No sparkle icons. No animated arrows. No arrow glyph after button labels.
- No AI stock photos, no AI illustrations, no vector people, no placeholder avatars.
- Use real product screenshots and real output only. If none exist, use none.
- No scroll animations, parallax, text reveals, typewriter effects, cursor effects, pulsing dots, shimmer, animated borders, or staggered page load fades.
- Hover changes only on real interactive elements and only subtle. Motion is allowed only to show state (running, done, error).

COPY
- No em dashes. Use commas, periods, or colons.
- The H1 states what the product does in concrete words: the input, the action, the output. No vague benefit lines.
- Never use: seamless, effortless, supercharge, unlock, streamline, empower, elevate, leverage, robust, cutting-edge, next-gen, revolutionize, game-changer, in minutes, at scale, 10x, blazing fast, lightning fast, powered by AI, AI-powered, reimagined, all-in-one, end-to-end, world-class, best-in-class, frictionless, intuitive, delightful, magical, transform your workflow, built for modern teams, ship with confidence, focus on what matters, actionable insights.
- No "It's not X, it's Y." No "Fast. Simple. Secure." tricolons. No "Meet X" or "Introducing X." No "Everything you need to", "Built for", "Designed for", "Powerful features for" headings.
- No check mark bullet lists as a selling device.
- Every feature description names the input and the output. Use specific verbs: checks, generates, blocks, fixes, scans, sends, imports, exports, compares, warns.
- If a sentence could describe 500 other products, rewrite it.
- No "Made with AI" or "Powered by AI" anywhere.

EVIDENCE
- No fake testimonials, reviews, logos, metrics, uptime numbers, speed claims, customer counts, live viewer counts, activity feeds, or dashboards.
- No big testimonial section. No three-tier pricing cards. Pricing is a plain table or one clear offer.
- Show the product doing its job. A real screenshot, a real result, a real before and after, or a working input on the page.

MUST ANSWER ON THE FIRST SCREEN
- What does this do? Who is it for? What do I enter? What do I get back? What happens next? Why should I trust the result?

SHIPPING
- Real page title, meta description, Open Graph image, brand favicon. No framework defaults.
- Loading states exist and match the content shape. No blank screens.
- Alt text on images, labels on icon-only controls, visible keyboard focus, no horizontal scroll on mobile, no console errors, no "#" links, no placeholder text.

BEFORE YOU RETURN
- Re-read your output against every rule above. Remove one wrapper layer from every section. Read every heading alone and rewrite any that could belong to another product. Search your copy for the banned words, for em dashes, and for emojis. Fix anything that fails. Then return the result with no commentary.
```

### 6.1 Short review variant

Use this on a page that already exists.

```
Review this page as a senior product designer who is strict about generic AI design. Check it against these categories and list every failure with the exact element, why it reads as generic, and the concrete replacement (rewrite copy where needed):

centered hero; nested cards or extra wrappers; gradients, glows, orbs, blur, glass; pills, badges, eyebrow labels, indicator pills; three equal cards or bento grids; drop shadows on non-floating elements; soft default radius; Inter, Space Grotesk, or other default fonts; flat type hierarchy; emojis, sparkle icons, animated arrows; AI stock images or placeholder avatars; scroll, hover, cursor, or load animations that do not show state; em dashes; vague hero text; banned SaaS words; "It's not X, it's Y"; tricolons; template headings; check mark bullets; fake testimonials, metrics, logos, or counters; three pricing tiers; missing real product demo; missing answers to what it does, who it is for, what you enter, what you get back; Tailwind or unmodified component library patterns; default title, favicon, or placeholder links; a light mode that is an inverted dark palette instead of its own design (check accent contrast, borders, status colors, and screenshot theme on light separately).

Prefer fewer components, more real product evidence, and clearer hierarchy. Do not add anything new. Only remove, replace, or rewrite.
```
