# -*- coding: utf-8 -*-
"""Піднімає ?v=N у index.html, щоб браузер забрав нові файли.

Запускати після кожної правки css/js:  python bump.py
Без цього і локальний браузер, і GitHub Pages віддають стару копію.
"""
import io, re, sys

PATH = 'index.html'
s = io.open(PATH, encoding='utf-8').read()

vs = [int(m) for m in re.findall(r'\?v=(\d+)', s)]
if not vs:
    sys.stdout.write('no ?v= markers in ' + PATH + '\n')
    raise SystemExit(1)

nxt = max(vs) + 1
s = re.sub(r'\?v=\d+', '?v=%d' % nxt, s)
io.open(PATH, 'w', encoding='utf-8', newline='\n').write(s)
sys.stdout.write('v%d -> v%d\n' % (max(vs), nxt))
