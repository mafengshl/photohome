/** @type {import('tailwindcss').Config} */
// Tailwind 配置：深色主题为主，扩展少量自定义颜色与字体
export default {
  content: ['./src/**/*.{astro,ts,tsx,js,jsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // 深色背景层级
        ink: {
          950: '#05070b',
          900: '#0a0d12',
          800: '#11151c',
          700: '#1a2029',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      maxWidth: {
        '8xl': '88rem',
      },
      transitionTimingFunction: {
        soft: 'cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
