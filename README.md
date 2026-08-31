# Веня — журнал діабету

Особистий застосунок для відміток по діабету кота: заміри, інсулін, годування,
ліки, сеча і стул. Для себе і для лікарів, які нас ведуть. Навайбкоджений.

Дані живуть у Google Таблиці — застосунок лише форма вводу і подання поверх неї.

- [architecture.md](docs/architecture.md) — як влаштовано
- [deploy.md](docs/deploy.md) — як підняти в себе
- [decisions.md](docs/decisions.md) — чому саме так

```bash
python -m http.server 8000   # запустити локально
python bump.py               # після правок css/js, інакше браузер віддасть стару копію
```

Ключів у репозиторії немає: ключ приходить у посиланні (`#k=…`) і осідає в
`localStorage`, адресу таблиці віддає скрипт тому, хто його пред'явив.

Тим самим посиланням можна передати й адресу скрипта — тоді новий пристрій
налаштовується одним переходом, а адреса не лежить у репозиторії:

```
…/?env=dev#k=КЛЮЧ&api=<адреса /exec, encodeURIComponent>
```

---

Personal tracker for a diabetic cat: glucose, insulin, food, meds, litter.
Built for my own use and for the vets who follow the case. Vibe-coded.

Data lives in a Google Sheet; this is just an input form and a set of views on
top of it. Not intended for reuse — but the docs above explain the whole thing
if you are curious.
