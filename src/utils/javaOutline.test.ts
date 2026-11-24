import { buildOutline, extractMembers, formatOutline, javapMemberAtLine, memberAtLine, parseJavapMembers, selectJavapMembers } from './javaOutline.js';

const SOURCE = [
    'package demo;',                                                        // 1
    '',                                                                     // 2
    'import java.util.*;',                                                  // 3
    '',                                                                     // 4
    '/** Class doc { not a block } */',                                     // 5
    '@SuppressWarnings({"unchecked", "rawtypes"})',                         // 6
    'public class Sample<T> implements Comparable<Sample<T>> {',            // 7
    '    private static final Map<String, Integer> COUNTS = new HashMap<>();', // 8
    '    private final Runnable task = () -> { System.out.println("}"); };', // 9
    '    int a, b;',                                                        // 10
    '    private static final int[] PRIMES = { 2, 3, 5 };',                 // 11
    '    private final Comparator<String> cmp = new Comparator<String>() {', // 12
    '        public int compare(String x, String y) { return 0; }',         // 13
    '    };',                                                               // 14
    '    static {',                                                         // 15
    '        COUNTS.put("a", 1);',                                          // 16
    '    }',                                                                // 17
    '',                                                                     // 18
    '    /**',                                                              // 19
    '     * Creates it.',                                                   // 20
    '     */',                                                              // 21
    '    public Sample(int a) {',                                           // 22
    '        final int local = a; // not a member',                         // 23
    '        if (local > 0) { this.a = local; }',                           // 24
    '    }',                                                                // 25
    '',                                                                     // 26
    '    @Override',                                                        // 27
    '    public int compareTo(Sample<T> other) {',                          // 28
    '        String text = """',                                            // 29
    '            { unbalanced',                                             // 30
    '            """;',                                                     // 31
    '        return text.length() + other.a;',                              // 32
    '    }',                                                                // 33
    '',                                                                     // 34
    '    <R> List<R> map(java.util.function.Function<T, R> fn, int... more) { return null; }', // 35
    '    abstract static class Base { abstract void run(); }',              // 36
    '',                                                                     // 37
    '    public enum Mode {',                                               // 38
    '        FAST("f") { int speed() { return 2; } },',                     // 39
    '        SLOW("s");',                                                   // 40
    '        private final String code;',                                   // 41
    '        Mode(String code) { this.code = code; }',                      // 42
    '        int speed() { return 1; }',                                    // 43
    '    }',                                                                // 44
    '',                                                                     // 45
    '    public record Point(int x, int y) {',                              // 46
    '        public Point { if (x < 0) throw new IllegalArgumentException(); }', // 47
    '    }',                                                                // 48
    '',                                                                     // 49
    '    @interface Marker { String value() default "x"; }',                // 50
    '    char brace() { return \'{\'; }',                                   // 51
    '}',                                                                    // 52
].join('\n');

describe('buildOutline', () => {
    const outline = buildOutline(SOURCE);
    const find = (name: string, kind?: string) => outline.filter(member => member.name === name && (!kind || member.kind === kind));

    it('records members of the top-level type with correct line ranges', () => {
        expect(find('Sample', 'type')[0]).toMatchObject({ startLine: 6, endLine: 52, depth: 0 });
        expect(find('COUNTS')[0]).toMatchObject({ kind: 'field', startLine: 8, depth: 1 });
        expect(find('task')[0]).toMatchObject({ kind: 'field', startLine: 9 });
        expect(find('a, b')[0]).toMatchObject({ kind: 'field', startLine: 10 });
        expect(find('PRIMES')[0]).toMatchObject({ kind: 'field', startLine: 11 });
        expect(find('cmp')[0]).toMatchObject({ kind: 'field', startLine: 12, endLine: 14 });
        expect(find('static {}')[0]).toMatchObject({ kind: 'initializer', startLine: 15, endLine: 17 });
        expect(find('Sample', 'constructor')[0]).toMatchObject({ startLine: 22, endLine: 25 });
        expect(find('compareTo')[0]).toMatchObject({ kind: 'method', startLine: 27, endLine: 33 });
        expect(find('map')[0]).toMatchObject({ kind: 'method', startLine: 35, endLine: 35 });
        expect(find('brace')[0]).toMatchObject({ kind: 'method', startLine: 51 });
    });

    it('does not report locals, anonymous-class members or statements as members', () => {
        expect(find('local')).toEqual([]);
        expect(find('compare')).toEqual([]);
        expect(find('text')).toEqual([]);
    });

    it('handles nested types, enums with constant bodies, records and annotation types', () => {
        expect(find('Base', 'type')[0]).toMatchObject({ depth: 1 });
        expect(find('run')[0]).toMatchObject({ kind: 'method', depth: 2, owner: ['Sample', 'Base'] });
        expect(find('(enum constants)')[0]).toMatchObject({ startLine: 39, endLine: 40, depth: 2 });
        expect(find('Mode', 'constructor')[0]).toMatchObject({ startLine: 42 });
        expect(find('speed').map(member => member.startLine)).toEqual([43]);
        expect(find('Point', 'type')[0]).toMatchObject({ startLine: 46, endLine: 48 });
        expect(find('Point', 'constructor')[0]).toMatchObject({ startLine: 47 });
        expect(find('Marker', 'type')[0]).toMatchObject({ startLine: 50 });
        expect(find('value')[0]).toMatchObject({ kind: 'method', owner: ['Sample', 'Marker'] });
    });

    it('formats a compact outline', () => {
        const text = formatOutline(outline);
        expect(text).toContain('L27-33       public int compareTo(Sample<T> other)');
        expect(text.split('\n')[0]).toMatch(/^L6-52 +public class Sample<T>/);
    });

    it('extracts members with their Javadoc and finds the member at a line', () => {
        const ctor = extractMembers(SOURCE, 'Sample');
        expect(ctor[0].start).toBe(19);
        expect(ctor[0].text).toContain('Creates it.');
        expect(extractMembers(SOURCE, 'map', ['Function', 'int...'])).toHaveLength(1);
        expect(extractMembers(SOURCE, 'map', ['String'])).toHaveLength(0);
        expect(memberAtLine(outline, 30)?.name).toBe('compareTo');
        expect(memberAtLine(outline, 16)?.kind).toBe('initializer');
    });
});

describe('parseJavapMembers', () => {
    const JAVAP = [
        'Compiled from "Demo.java"',
        'public class demo.Demo {',
        '  private final int a;',
        '    descriptor: I',
        '',
        '  public demo.Demo(int);',
        '    descriptor: (I)V',
        '    Code:',
        '       0: aload_0',
        '    LineNumberTable:',
        '      line 10: 0',
        '      line 12: 4',
        '',
        '  public static boolean isBlank(java.lang.CharSequence);',
        '    descriptor: (Ljava/lang/CharSequence;)Z',
        '    Code:',
        '       0: iconst_1',
        '    LineNumberTable:',
        '      line 20: 0',
        '      line 25: 1',
        '',
        '  public static boolean isBlank(java.lang.String, int);',
        '    descriptor: (Ljava/lang/String;I)Z',
        '    Code:',
        '       0: iconst_1',
        '',
        '  static {};',
        '    descriptor: ()V',
        '    LineNumberTable:',
        '      line 5: 0',
        '}',
    ].join('\n');
    const parsed = parseJavapMembers(JAVAP, 'demo.Demo');

    it('splits members and reads line numbers', () => {
        expect(parsed.header).toContain('public class demo.Demo {');
        expect(parsed.members.map(member => member.name)).toEqual(['a', '<init>', 'isBlank', 'isBlank', '<clinit>']);
        expect(parsed.members[1].lines).toEqual([10, 12]);
    });

    it('selects overloads and the member at a source line', () => {
        expect(selectJavapMembers(parsed.members, 'isBlank')).toHaveLength(2);
        expect(selectJavapMembers(parsed.members, 'isBlank', ['String', 'int'])).toHaveLength(1);
        expect(selectJavapMembers(parsed.members, 'Demo', undefined, 'demo.Demo')).toHaveLength(1);
        expect(javapMemberAtLine(parsed.members, 22)?.signature).toBe('public static boolean isBlank(java.lang.CharSequence);');
        expect(javapMemberAtLine(parsed.members, 99)).toBeUndefined();
    });
});
