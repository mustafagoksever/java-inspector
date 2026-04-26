import { extractMethod, extractMethodMap, MethodLineRange } from './methodExtractor.js';

describe('extractMethod', () => {
    it('should extract a simple method with body', () => {
        const source = `public class Foo {
    public int add(int a, int b) {
        return a + b;
    }
}`;
        const result = extractMethod(source, 'add');
        expect(result).toBe(`    public int add(int a, int b) {
        return a + b;
    }`);
    });

    it('should return null if method not found', () => {
        const source = `public class Foo {
    public void bar() {}
}`;
        expect(extractMethod(source, 'baz')).toBeNull();
    });

    it('should handle nested braces', () => {
        const source = `public class Foo {
    public void outer() {
        if (true) {
            for (int i = 0; i < 10; i++) {
                System.out.println(i);
            }
        }
    }
}`;
        const result = extractMethod(source, 'outer');
        expect(result).toContain('if (true) {');
        expect(result).toContain('for (int i = 0; i < 10; i++) {');
        expect(result).toContain('System.out.println(i);');
        expect(result).toContain('}');
        // Should end with the closing brace of outer()
        const lines = result!.split('\n');
        expect(lines[lines.length - 1].trim()).toBe('}');
    });

    it('should ignore braces inside strings', () => {
        const source = `public class Foo {
    public String greet() {
        return "Hello {world}";
    }
}`;
        const result = extractMethod(source, 'greet');
        expect(result).toBe(`    public String greet() {
        return "Hello {world}";
    }`);
    });

    it('should ignore braces inside single-quoted strings', () => {
        const source = `public class Foo {
    public char getBrace() {
        return '{';
    }
}`;
        const result = extractMethod(source, 'getBrace');
        expect(result).toBe(`    public char getBrace() {
        return '{';
    }`);
    });

    it('should handle escaped quotes inside strings', () => {
        const source = `public class Foo {
    public String quote() {
        return "He said \\"hello\\"";
    }
}`;
        const result = extractMethod(source, 'quote');
        expect(result).toBe(`    public String quote() {
        return "He said \\"hello\\"";
    }`);
    });

    it('should handle line comments with braces', () => {
        const source = `public class Foo {
    public void foo() {
        // comment with {
        int x = 1;
    }
}`;
        const result = extractMethod(source, 'foo');
        expect(result).toContain('// comment with {');
        expect(result).toContain('int x = 1;');
    });

    it('should handle block comments with braces', () => {
        const source = `public class Foo {
    public void foo() {
        /* block { comment } */
        int x = 1;
    }
}`;
        const result = extractMethod(source, 'foo');
        expect(result).toContain('/* block { comment } */');
        expect(result).toContain('int x = 1;');
    });

    it('should extract abstract method ending with semicolon', () => {
        const source = `public abstract class Foo {
    public abstract void doSomething();
}`;
        const result = extractMethod(source, 'doSomething');
        expect(result).toBe(`    public abstract void doSomething();`);
    });

    it('should extract multi-line abstract method signature', () => {
        const source = `public abstract class Foo {
    public abstract void doSomething(
        int a,
        int b
    );
}`;
        const result = extractMethod(source, 'doSomething');
        expect(result).toBe(`    public abstract void doSomething(
        int a,
        int b
    );`);
    });

    it('should match method name as whole word only', () => {
        const source = `public class Foo {
    public void add() {}
    public void addition() {}
}`;
        const result = extractMethod(source, 'add');
        expect(result).toContain('add()');
        expect(result).not.toContain('addition()');
    });

    it('should handle method with generic return type', () => {
        const source = `public class Foo {
    public List<String> getList() {
        return new ArrayList<>();
    }
}`;
        const result = extractMethod(source, 'getList');
        expect(result).toContain('public List<String> getList()');
        expect(result).toContain('return new ArrayList<>();');
    });

    it('should return all overloads when paramTypes is not provided', () => {
        const source = `public class Foo {
    public int add(int a, int b) {
        return a + b;
    }
    public String add(String a, String b) {
        return a + b;
    }
}`;
        const result = extractMethod(source, 'add');
        expect(result).toContain('int a, int b');
        expect(result).toContain('String a, String b');
        expect(result).toContain('// ===== Method Overload =====');
    });

    it('should filter by paramTypes to select specific overload', () => {
        const source = `public class Foo {
    public int add(int a, int b) {
        return a + b;
    }
    public String add(String a, String b) {
        return a + b;
    }
}`;
        const result1 = extractMethod(source, 'add', ['int', 'int']);
        expect(result1).toContain('int a, int b');
        expect(result1).not.toContain('String a, String b');

        const result2 = extractMethod(source, 'add', ['String', 'String']);
        expect(result2).toContain('String a, String b');
        expect(result2).not.toContain('int a, int b');
    });

    it('should handle generic types in paramTypes', () => {
        const source = `public class Foo {
    public void process(List<String> items) {
        System.out.println(items);
    }
    public void process(List<Integer> numbers) {
        System.out.println(numbers);
    }
}`;
        const result1 = extractMethod(source, 'process', ['List<String>']);
        expect(result1).toContain('List<String> items');

        const result2 = extractMethod(source, 'process', ['List<Integer>']);
        expect(result2).toContain('List<Integer> numbers');
    });

    it('should handle final modifier in paramTypes', () => {
        const source = `public class Foo {
    public void doSomething(final String value) {
        System.out.println(value);
    }
    public void doSomething(int value) {
        System.out.println(value);
    }
}`;
        const result1 = extractMethod(source, 'doSomething', ['String']);
        expect(result1).toContain('final String value');

        const result2 = extractMethod(source, 'doSomething', ['int']);
        expect(result2).toContain('int value');
    });

    it('should handle array types in paramTypes', () => {
        const source = `public class Foo {
    public void handle(String[] items) {
        System.out.println(items);
    }
    public void handle(int[] numbers) {
        System.out.println(numbers);
    }
}`;
        const result1 = extractMethod(source, 'handle', ['String[]']);
        expect(result1).toContain('String[] items');

        const result2 = extractMethod(source, 'handle', ['int[]']);
        expect(result2).toContain('int[] numbers');
    });
});

describe('extractMethodMap', () => {
    it('should extract method ranges for a class with multiple methods', () => {
        const source = `public class Foo {
    public void a() {
        int x = 1;
    }
    public void b() {
        int y = 2;
    }
}`;
        const methods = extractMethodMap(source);
        expect(methods.length).toBe(2);
        expect(methods[0].name).toBe('a');
        expect(methods[0].startLine).toBe(2);
        expect(methods[0].endLine).toBe(4);
        expect(methods[1].name).toBe('b');
        expect(methods[1].startLine).toBe(5);
        expect(methods[1].endLine).toBe(7);
    });

    it('should include constructor as a method', () => {
        const source = `public class Foo {
    public Foo() {
        this.value = 0;
    }
    public void bar() {}
}`;
        const methods = extractMethodMap(source);
        const ctor = methods.find(m => m.name === 'Foo');
        expect(ctor).toBeDefined();
        expect(ctor!.startLine).toBe(2);
    });

    it('should handle single-line abstract methods', () => {
        const source = `public abstract class Foo {
    public abstract void doSomething();
    public void concrete() {
        int x = 1;
    }
}`;
        const methods = extractMethodMap(source);
        const abstract = methods.find(m => m.name === 'doSomething');
        expect(abstract).toBeDefined();
        expect(abstract!.startLine).toBe(2);
        expect(abstract!.endLine).toBe(2);
    });

    it('should not detect multi-line signatures in extractMethodMap (current limitation)', () => {
        // extractMethodMap requires ')' on the same line as '(' for detection
        const source = `public abstract class Foo {
    public abstract void doSomething(
        int a,
        int b
    );
}`;
        const methods = extractMethodMap(source);
        const abstract = methods.find(m => m.name === 'doSomething');
        expect(abstract).toBeUndefined();
    });

    it('should skip fields even if they have modifiers', () => {
        // Note: current heuristic accepts all modifier+( ) patterns,
        // so fields with `=` on same line as `(` are skipped by the ( ) check,
        // but fields without parens are naturally skipped.
        const source = `public class Foo {
    private static final int MAX = 100;
    public void foo() {}
}`;
        const methods = extractMethodMap(source);
        expect(methods.length).toBe(1);
        expect(methods[0].name).toBe('foo');
    });

    it('should return empty array for class with no methods', () => {
        const source = `public interface Marker {}`;
        expect(extractMethodMap(source)).toEqual([]);
    });

    it('should capture signatures', () => {
        const source = `public class Foo {
    public static synchronized String getName(int id, String prefix) {
        return prefix + id;
    }
}`;
        const methods = extractMethodMap(source);
        expect(methods.length).toBe(1);
        expect(methods[0].signature).toBe('public static synchronized String getName(int id, String prefix) {');
    });
});
