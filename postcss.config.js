// PostCSS 配置。这里不加 JSDoc 类型标注：postcss-load-config 没装，
// 而 tsconfig 开了 checkJs，引用不存在的类型包会让 typecheck 直接红。
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
