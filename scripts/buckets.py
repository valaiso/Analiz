"""TEFAS varlık dağılımı alanlarını okunabilir varlık sınıflarına gruplar.

Alan kısaltmaları TEFAS'ın `dagilimSiraliGetirT` ucunun döndürdüğü yüzde
sütunlarıdır. Her sütun fonun portföyünün yüzde kaçının o varlıkta olduğunu
söyler; aşağıdaki gruplar bunları anlaşılır sınıflara toplar.
"""

BUCKETS: dict[str, tuple[str, ...]] = {
    "Hisse Senedi": ("hs",),
    "Yabancı Hisse Senedi": ("yhs",),
    "Kamu Borçlanma": ("dt", "hb", "kba", "kibd", "dot", "db", "eut", "ybkb",
                       "kks", "kkstl", "kksd", "kksyd"),
    "Özel Sektör Borçlanma": ("ost", "osdb", "fb", "bb", "vdm", "osks", "oksyd",
                              "ybosb", "yba"),
    "Para Piyasası & Repo": ("tpp", "bpp", "btaa", "btas", "r", "tr"),
    "Mevduat & Katılma": ("vm", "vmtl", "vmd", "kh", "khtl", "khd"),
    "Kıymetli Maden": ("km", "kmbyf", "kmkba", "kmkks", "vmau", "khau"),
    "Fon & BYF": ("fkb", "yyf", "byf", "ybyf"),
    "Gayrimenkul & Girişim": ("gykb", "gyy", "gsykb", "gsyy", "gas"),
    "Türev & Diğer": ("t", "vint", "ymk", "d"),
}

# Grafiklerde kullanılacak sabit sıra (renk tutarlılığı için).
BUCKET_ORDER = list(BUCKETS)


def summarize(row: dict, fund_name: str = "") -> dict[str, float]:
    """Ham dağılım satırını varlık sınıfı -> yüzde sözlüğüne çevirir.
    Eğer fon unvanında YABANCI geçiyorsa hisse senedi kalemi Yabancı Hisse Senedi olarak sınıflandırılır.
    """
    out: dict[str, float] = {}
    is_foreign_fund = "YABANCI" in fund_name.upper()

    for bucket, fields in BUCKETS.items():
        total = 0.0
        for field in fields:
            value = row.get(field)
            if isinstance(value, (int, float)):
                total += float(value)
        
        if total > 0.005:
            # Eğer fon unvanında YABANCI geçiyorsa ve düz "Hisse Senedi" geldiyse bunu Yabancı Hisse Senedi'ne aktar
            target_bucket = bucket
            if bucket == "Hisse Senedi" and is_foreign_fund:
                target_bucket = "Yabancı Hisse Senedi"

            out[target_bucket] = round(out.get(target_bucket, 0.0) + total, 2)

    return out