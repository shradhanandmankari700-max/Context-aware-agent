import { isoDay, rng } from "./rng";
export const DEMO_NOW = "2026-10-07";
const random = rng(2107);
const base = [
  ["Paracetamol","Painkiller",120,20],["Amoxicillin","Antibiotic",12,15],["Insulin","Diabetes",5,8],["Azithromycin","Antibiotic",80,10],["Metformin","Diabetes",18,6],["Salbutamol","Respiratory",30,8],
  ["Ibuprofen","Painkiller",180,20],["Aspirin","Painkiller",140,16],["Cetirizine","Respiratory",90,12],["Cefixime","Antibiotic",110,14],["Doxycycline","Antibiotic",120,15],["Glimepiride","Diabetes",96,12],["Amlodipine","Cardiac",160,16],["Atorvastatin","Cardiac",130,13],["Omeprazole","Gastro",150,15],["Pantoprazole","Gastro",100,10],["ORS","Gastro",140,14],["Montelukast","Respiratory",105,14],["Losartan","Cardiac",120,12],[" diclofenac","Painkiller",90,10],["Clarithromycin","Antibiotic",100,10],["Gliclazide","Diabetes",110,11]
] as const;
export const medicines = base.map(([medicine,category,stock,daily_usage]) => ({ medicine: medicine.trim(), category, stock, daily_usage, expiry_date: isoDay(-180) }));
export const medicine_usage = medicines.flatMap(m => Array.from({length:120},(_,i) => {
  const date=isoDay(119-i), day=date.slice(8);
  let avg=m.medicine==="Amoxicillin" ? (date<="2026-09-22"?9:15) : m.medicine==="Insulin"?8 : m.medicine==="Metformin"? (date>="2026-09-20"?5:6) : m.medicine==="Salbutamol"?(date>="2026-09-25"?7:8):m.daily_usage;
  let quantity=m.medicine==="Insulin"?8:Math.max(1,Math.round(avg+(random()-.5)*2));
  // make the demo MTD comparison a clear, deterministic +12% increase
  if (m.medicine==="Paracetamol" && date.startsWith("2026-10-")) quantity=24;
  if (m.medicine==="Paracetamol" && date.startsWith("2026-09-")) quantity=20;
  return {usage_date:date,medicine:m.medicine,quantity};
}));
export const purchases = [
  {order_date:"2026-08-28",medicine:"Amoxicillin",quantity:60,supplier:"MedSupply",status:"Delivered"},
  {order_date:"2026-08-20",medicine:"Insulin",quantity:100,supplier:"CarePharma",status:"Delivered"},
  ...Array.from({length:58},(_,i)=>({order_date:isoDay((i*2)%115),medicine:medicines[6+((i*7+4)%(medicines.length-6))]!.medicine,quantity:i%4===0?160:150,supplier:`Supplier ${(i%6)+1}`,status:i%13===0?"Delayed":i%17===0?"Pending":"Delivered"}))
];
const basePrescriptions = Array.from({length:600},(_,i)=>{
  const d=isoDay(i%120), medicine=medicines[(i*7+3)%medicines.length]!.medicine;
  const amox=medicine==="Amoxicillin";
  const later=d>="2026-09-23";
  return {prescribed_on:d,medicine,diagnosis:amox?"Respiratory infection":i%3===0?"Routine care":i%3===1?"Respiratory infection":"Chronic condition",quantity:amox?(later?3:2):1+Math.floor(random()*3)};
});
export const prescriptions = [...basePrescriptions,...Array.from({length:15},(_,i)=>({prescribed_on:isoDay(i),medicine:"Amoxicillin",diagnosis:"Respiratory infection",quantity:1}))];
export const stock_history=medicines.flatMap(m=>Array.from({length:120},(_,i)=>({snapshot_date:isoDay(119-i),medicine:m.medicine,stock:Math.max(m.stock,Math.round(m.stock+(119-i)*m.daily_usage*.6))})));
export const patients=Array.from({length:40},(_,i)=>({patient_id:`P${String(i+1).padStart(3,"0")}`,name:["Aarav Shah","Maya Rao","Noah Lim","Isha Patel"][i%4]+` ${i+1}`,age:18+(i*7)%73,ward:["General","ICU","Pediatrics","Maternity"][i%4],admitted_on:isoDay(i*3),status:i%3?"Discharged":"Admitted"}));
export const hospitalData={medicines,medicine_usage,purchases,prescriptions,stock_history,patients};
