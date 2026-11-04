declare module 'monaco-editor/editor/editor.api' {
  export * from 'monaco-editor'
}

declare module '*?worker&inline' {
  const WorkerFactory: new () => Worker
  export default WorkerFactory
}
