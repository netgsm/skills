// Test yardımcısı: TypeScript dosyalarını `tsc --noEmit --strict --target es2022 --module nodenext
// --lib es2022,dom` ile denetler. Kullanıcı projesinde @types/node olmayabilir; burada da kullanılmaz.
import ts from 'typescript';

/** Tanılama metnini döner; hata yoksa boş dize. */
export function typecheck(files) {
  const options = {
    noEmit: true, strict: true, skipLibCheck: true, types: [],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  };
  const program = ts.createProgram(files, options);
  return ts.formatDiagnostics(ts.getPreEmitDiagnostics(program), {
    getCanonicalFileName: (f) => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  });
}
