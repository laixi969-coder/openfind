from pathlib import Path
from html import escape
palettes=[('#eee7db','#444d3b','#c7c3ac'),('#f1ddd5','#903e37','#d4b1a2'),('#e4e9e4','#345348','#b4c8bb'),('#e9e1d4','#483d33','#c7b59b'),('#e6e1ed','#544a68','#c3b7d4'),('#edebdb','#5c6440','#bbc4a0'),('#e3e9ee','#3c5366','#a4bac9'),('#f2e2d9','#9c603f','#d9b79d'),('#eee9e1','#6c5949','#c9bcaa'),('#dce6db','#4c6149','#9fb59e'),('#e9e0dc','#754b43','#c7aaa1'),('#e6e5dd','#5c6254','#b7bdac')]
texts=[('把日子','过成喜欢的样子','生活灵感 / VOL.01'),('这 6 件事','越早知道越好','一份认真整理的避坑清单'),('慢下来','才有新的发现','LESS, BUT BETTER.'),('好的选择','从了解自己开始','给正在做功课的你'),('长期主义','是最好的答案','我的生活提案 / 2026'),('理想生活','没有标准答案','YOUR OWN KIND OF GOOD'),('普通人的','松弛感指南','不费力，也可以很好'),('关于预算','这篇终于讲清楚','REAL NOTES / REAL LIFE'),('在小小角落','找到生活的光','留一点时间给自己'),('不盲目跟风','只选适合自己的','灵感收藏夹 / 第十期'),('认真生活的','一些小小证据','GOOD THINGS TAKE TIME'),('从 0 到 1','值得收藏的经验','一篇讲清楚 · 建议收藏')]
for i,((bg,ink,muted),(a,b,sub)) in enumerate(zip(palettes,texts),1):
 h=[560,640,520,600,540,620,580,530,650,570,610,540][i-1]
 scene=f'''<rect x="25" y="235" width="350" height="{h-260}" rx="3" fill="{muted}"/>
 <rect x="50" y="258" width="145" height="145" fill="{bg}" opacity=".75"/><path d="M122 258v145M50 330h145" stroke="{muted}" stroke-width="5"/>
 <ellipse cx="205" cy="{h-49}" rx="139" ry="20" fill="{bg}" opacity=".55"/>
 <rect x="113" y="{h-160}" width="180" height="79" rx="17" fill="{ink}" opacity=".83"/><rect x="101" y="{h-134}" width="29" height="57" rx="9" fill="{ink}"/><rect x="277" y="{h-134}" width="29" height="57" rx="9" fill="{ink}"/><path d="M123 {h-79}v18m163-18v18" stroke="{ink}" stroke-width="7"/>
 <rect x="323" y="{h-132}" width="19" height="63" fill="{ink}" opacity=".6"/><path d="M332 {h-132}q-60-70-33-76 26 6 33 76M332 {h-132}q43-94 55-61 4 26-55 61" fill="{ink}" opacity=".7"/>'''
 if i%3==2:
  scene=f'''<rect x="35" y="237" width="330" height="{h-273}" fill="{muted}" opacity=".45"/>
  <circle cx="200" cy="{h-153}" r="98" fill="{bg}" opacity=".8"/><circle cx="200" cy="{h-153}" r="73" fill="none" stroke="{ink}" stroke-width="1" opacity=".4"/>
  <text x="200" y="{h-130}" font-size="78" text-anchor="middle" font-weight="400" font-family="Georgia,serif" fill="{ink}">0{i if i<10 else i-9}</text><path d="M70 {h-51}h260" stroke="{ink}" opacity=".35"/>
  <text x="200" y="{h-31}" font-size="10" text-anchor="middle" fill="{ink}" letter-spacing="3">A LITTLE GUIDE TO BETTER DAYS</text>'''
 if i%3==0:
  scene=f'''<rect x="35" y="235" width="330" height="{h-270}" fill="{muted}" opacity=".5"/>
  <path d="M68 {h-53}Q83 260 200 264Q341 265 333 {h-53}" fill="{bg}" opacity=".8"/>
  <path d="M199 {h-64}V307" stroke="{ink}" stroke-width="3"/><path d="M199 354q-100-85-68-91 62-3 68 91m0 25q89-112 99-69 9 38-99 69m0 27q-107-66-95-20 23 37 95 20m0 25q96-91 105-53 5 39-105 53" fill="{ink}" opacity=".65"/>
  <ellipse cx="200" cy="{h-56}" rx="61" ry="9" fill="{ink}" opacity=".15"/>'''
 svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="400" height="{h}" viewBox="0 0 400 {h}"><rect width="400" height="{h}" fill="{bg}"/><g font-family="PingFang SC,Noto Sans SC,Microsoft YaHei,sans-serif" fill="{ink}"><text x="29" y="35" font-size="10" letter-spacing="2">THE EVERYDAY EDIT</text><text x="370" y="35" text-anchor="end" font-size="10">{i:02}</text><path d="M28 50h344" stroke="{ink}" opacity=".3"/><text x="28" y="113" font-size="38" font-weight="650" letter-spacing="1">{escape(a)}</text><text x="28" y="165" font-size="{32 if len(b)>7 else 38}" font-weight="650">{escape(b)}</text><text x="30" y="201" font-size="13" letter-spacing="1">{escape(sub)}</text>{scene}<rect x="25" y="{h-24}" width="180" height="16" fill="{bg}"/><text x="28" y="{h-12}" font-size="8" letter-spacing="1.5">OPENFIND · 本地演示素材</text></g></svg>'''
 Path(f'public/assets/cover-{i}.svg').write_text(svg)
print('12 local SVG covers created')
