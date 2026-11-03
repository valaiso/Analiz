# Her içe aktarılan adın hedef modülde gerçekten dışa aktarıldığını denetler.
import re, pathlib, sys
root = pathlib.Path(sys.argv[1]) / 'assets' / 'js'
bad = 0
for p in root.rglob('*.js'):
    s = p.read_text(encoding='utf-8')
    for m in re.finditer(r'import\s*\{([^}]*)\}\s*from\s*[\'"](\.[^\'"]+)[\'"]', s):
        target = (p.parent / m.group(2)).resolve()
        if not target.exists(): print('YOK', p, m.group(2)); bad += 1; continue
        t = target.read_text(encoding='utf-8')
        for n in [x.strip().split(' as ')[0].strip() for x in m.group(1).split(',') if x.strip()]:
            if not re.search(r'export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+' + re.escape(n) + r'(?![\w$])', t) and not re.search(r'export\s*\{[^}]*(?<![\w$])' + re.escape(n) + r'(?![\w$])', t):
                print(f'EKSİK: {p.relative_to(root)} -> {n} ({m.group(2)})'); bad += 1
print(f'içe aktarma denetimi: {bad} sorun')
sys.exit(1 if bad else 0)
