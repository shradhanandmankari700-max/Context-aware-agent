import { isoDay, rng } from "./rng";
const random=rng(771);
const roomDefs=[["101","Deluxe",2500],["102","Suite",4500],["103","Deluxe",2800],["104","Standard",1800],["105","Standard",2200],["106","Standard",1900],["107","Deluxe",2900],["108","Suite",4800],["109","Standard",2400],["110","Deluxe",2700],["111","Standard",2100],["112","Suite",4200]] as const;
export const room_availability=roomDefs.flatMap(([room,room_type,price],ri)=>Array.from({length:150},(_,i)=>{
  const stay_date=isoDay(119-i);
  // Future rows (i >= 120): today is index 126, tomorrow 127.
  const future=isoDay(-(i-119));
  const date=i<120?stay_date:future;
  let status: string;
  if(date==="2026-10-07") status=["101","102","104","105"].includes(room)?"Available":"Occupied";
  else if(date==="2026-10-08") status=room==="101"?"Occupied":(["104","105"].includes(room)?"Available":(ri%3===0?"Occupied":"Available"));
  else status=random() < (date.startsWith("2026-09") && new Date(`${date}T00:00:00Z`).getUTCDay()>0 && new Date(`${date}T00:00:00Z`).getUTCDay()<6 ? .38 : .68)?"Occupied":"Available";
  return {room,room_type,price,status,stay_date:date};
}));
const bookings=Array.from({length:400},(_,i)=>{
  const check_in=isoDay(i%120), channel=i%5===0?"OTA":i%4===0?"Corporate":"Direct";
  const sep=check_in.startsWith("2026-09");
  const cancelled=channel==="OTA" && sep ? i%3===0 : i%19===0;
  return {booking_id:`B${String(i+1).padStart(4,"0")}`,room:roomDefs[i%12]![0],guest:`Guest ${i+1}`,check_in,check_out:isoDay(i%120-2),amount:1800+(i*137)%3700,channel,status:cancelled?"Cancelled":i%4===0?"Completed":"Confirmed"};
});
export const bookingsData=bookings;
export const revenue=Array.from({length:120*4},(_,i)=>{
  const revenue_date=isoDay(119-Math.floor(i/4)), category=["Room Bookings","Restaurant","Spa","Events"][i%4]!;
  const month=revenue_date.slice(5,7), base=category==="Room Bookings"?100000:category==="Restaurant"?25000:category==="Spa"?12000:8000;
  const amount=Math.round(base*(month==="09"&&category==="Room Bookings"?.855:month==="09"?.995:1)*(0.98+random()*.04));
  return {revenue_date,category,amount};
});
export const occupancy_history=Array.from({length:120},(_,i)=>{const occupancy_date=isoDay(119-i), dow=new Date(`${occupancy_date}T00:00:00Z`).getUTCDay();return {occupancy_date,occupied_rooms:Math.round((occupancy_date.startsWith("2026-09")&&dow>0&&dow<6?5.2:7.4)+random()*2),total_rooms:12};});
export const hotelData={room_availability,bookings,revenue,occupancy_history};
