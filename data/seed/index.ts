import { mkdir, writeFile } from "node:fs/promises";
import { hospitalData } from "./hospital";
import { hotelData } from "./hotel";
const dir=new URL("../generated/",import.meta.url);
async function main(){
 await mkdir(dir,{recursive:true});
 await Promise.all([
  writeFile(new URL("hospital.data.json",dir),JSON.stringify(hospitalData,null,2)+"\n"),
  writeFile(new URL("hotel.data.json",dir),JSON.stringify(hotelData,null,2)+"\n"),
 ]);
 console.log(`seeded hospital (${Object.values(hospitalData).reduce((n,r)=>n+r.length,0)} rows), hotel (${Object.values(hotelData).reduce((n,r)=>n+r.length,0)} rows)`);
}
void main();
