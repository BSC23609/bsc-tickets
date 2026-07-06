module.exports = {
  content: ['./public/**/*.html'],
  theme: {
    extend: {
      colors: {
        brand: { 50:'#EAF2F8',100:'#D5E6F1',300:'#7FB3D5',500:'#1B7BC0',600:'#0E6AA6',700:'#0A557F',800:'#0A4566',ink:'#112532' },
        ink:'#112532', mist:'#F5F8FB', line:'#E6EDF3'
      },
      fontFamily: {
        sans:['Inter','ui-sans-serif','system-ui','sans-serif'],
        display:['Space Grotesk','ui-sans-serif','sans-serif'],
        mono:['Space Mono','ui-monospace','monospace']
      }
    }
  },
  safelist: [
    { pattern: /(bg|text|border)-(slate|emerald|amber|red|blue|indigo|purple|yellow|brand)-(50|100|200|300|400|500|600|700|800)/ }
  ]
};
