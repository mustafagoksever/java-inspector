# PLAN: offset/limit Ekleme + Token Verimliliği İyileştirmeleri

## Hedef
Büyük Java class'larını decompile ederken satır limiti belirleyebilmek. Ayrıca mevcut tool'ların token verimliliğini artırmak.

## Karar Verildi
- **Parametreler**: `offset` + `limit` (read tool ile uyumlu)
- **Index**: 1-based
- **Limit=0**: Tüm satırlar (mevcut davranış)
- **Mantık**: `src/index.ts` handler'da, sourceCode alındıktan sonra slice

---

## 1. Değişiklik: `decompile_class` offset/limit

### 1.1 Input Schema (`src/index.ts` ~line 82-88)

```typescript
offset: {
    type: 'number',
    description: 'Start line number (1-based, default: 1)',
    default: 1,
},
limit: {
    type: 'number',
    description: 'Max lines to return (0 = all lines)',
    default: 0,
},
```

### 1.2 Handler Logic (`src/index.ts` ~line 265-299)

```typescript
const { className, projectPath, useCache = true, decompilerPath, offset = 1, limit = 0 } = args;

// sourceCode alındıktan sonra:
if (offset > 1 || limit > 0) {
    const lines = sourceCode.split('\n');
    const totalLines = lines.length;

    // Validate offset (1-based, clamp <=0 to 1)
    const effectiveOffset = offset <= 0 ? 1 : offset;
    if (effectiveOffset > totalLines) {
        return {
            content: [{
                type: 'text',
                text: `Offset ${effectiveOffset} exceeds total lines ${totalLines}`,
            }],
        };
    }

    // Calculate slice range
    const effectiveLimit = limit < 0 ? 0 : limit;
    const startIndex = effectiveOffset - 1;
    const endIndex = effectiveLimit > 0
        ? Math.min(startIndex + effectiveLimit, totalLines)
        : totalLines;

    let slicedCode = lines.slice(startIndex, endIndex).join('\n');

    return {
        content: [{
            type: 'text',
            text: `Decompiled source code for class ${className} (lines ${effectiveOffset}-${endIndex} of ${totalLines}):\n\n\`\`\`java\n${slicedCode}\n\`\`\``,
        }],
    };
}
```

> **Not**: `sourceCode` değişkeni `const` → `let` yapılmalı ve ayrı `slicedCode` değişkeni kullanılmalı (`sourceCode = slicedCode` ataması yerine).

### 1.3 Edge Cases

| Input | Davranış |
|-------|----------|
| `offset <= 0` | `offset=1` olarak işlenir (clamp) |
| `offset > totalLines` | Hata mesajı döner |
| `limit < 0` | `limit=0` olarak işlenir (tüm satırlar) |
| `limit=0` | Tüm satırlar (mevcut davranış) |
| `offset=1, limit=0` | Tüm dosya (mevcut davranış) |

---

## 2. Değişiklik: `find_implementations` limit parametresi

### Sorun
`findImplementations()` tüm class'ları tek tek `analyzeClass()` ile tarıyor. `List`, `Serializable` gibi yaygın interfacelerde **binlerce sonuç** dönebilir. Response tek bir text bloğu olarak gidiyor — hem zaman hem token açısından israf.

### Input Schema
```typescript
limit: {
    type: 'number',
    description: 'Maximum number of implementations to return (0 = all)',
    default: 50,
},
```

### Handler Logic
`handleFindImplementations` içinde sonuç dizisi `limit` ile slice edilecek. `limit=0` tüm sonuçları döndürür (backward compatible).

---

## 3. Değişiklik: Error Response kısaltma

### Sorun
Genel catch bloğunda şu suggestions tekrar ediyor (~30-50 token/hata):
```
Suggestions:
1. Check if input parameters are correct
2. Ensure necessary preparations have been completed
3. Check server logs for detailed information
```

### Düzeltme
Genel catch bloktan suggestions kaldırılacak. Sadece `errorMessage` dönecek:
```typescript
return {
    content: [{
        type: 'text',
        text: `Tool call failed: ${errorMessage}`,
    }],
};
```
Spesifik tool'ların (örn. `decompile_class`) kendi catch bloklarındaki suggestions da kısaltılacak.

---

## 4. Opsiyonel Gelecek Çalışmalar (Bu plan dışında)

| Konu | Açıklama | Karmaşıklık |
|------|----------|-------------|
| `analyze_class` method limiti | Çok büyük class'larda (100+ method) output uzun. `includeMethods` / `includeFields` flag'leri eklenebilir. | Düşük |
| `getInheritanceHierarchy` optimizasyonu | Recursive `analyzeClass` → `javap` çağrısı. Sonuç genelde kısa ama derin hiyerarşide yavaş. | Orta |
| Index'e superclass/interface ekleme | `ClassIndexEntry`'ye `superClass` ve `interfaces` eklense, `findImplementations`/`findSubClasses` diskten okur, JAR'a dokunmaz. | Yüksek |
| Inner class desteği | `BackgroundScanner` `$` içeren class'ları atlıyor. Decompile ederken inner class'lar görünmüyor. | Orta |

---

## Dosyalar

| Dosya | Değişiklik |
|-------|-----------|
| `src/index.ts` | `decompile_class` input schema + handler logic + `find_implementations` limit + error response kısaltma |

---

## Örnek Kullanım

```typescript
decompile_class(
    className="com.example.LargeService",
    projectPath="/path/to/project",
    offset=50,    // 50. satırdan başla
    limit=100,    // 100 satır döndür
)
// → Lines 50-149 döner

decompile_class(
    className="com.example.LargeService",
    projectPath="/path/to/project",
    limit=50      // İlk 50 satır
)
// → Lines 1-50 döner
```

---

## Status

- [x] Plan oluşturuldu
- [ ] Onay alındı
- [ ] Implementasyon
- [ ] Test
