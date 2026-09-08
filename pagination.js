(function(root){
  const segmenter=new Intl.Segmenter('ja',{granularity:'grapheme'});
  const segments=text=>Array.from(segmenter.segment(String(text)),x=>x.segment);
  const punctuation=ch=>['。','、','｡','､'].includes(ch);
  const half=ch=>ch==='。'?'｡':ch==='、'?'､':ch;
  function rows(lines,columns){
    return lines.flatMap(text=>String(text).replace(/\r\n?/g,'\n').split('\n').flatMap(line=>{
      const chars=segments(line),out=[];let offset=0;
      while(offset<chars.length){
        let end=Math.min(offset+columns,chars.length),row=chars.slice(offset,end);
        if(end<chars.length&&punctuation(chars[end])){
          // A punctuation run stays attached to preceding text. At most one hangs outside the nominal width.
          let runEnd=end;while(runEnd<chars.length&&punctuation(chars[runEnd]))runEnd++;
          if(runEnd>end+1){
            let split=end;while(split>offset&&punctuation(chars[split-1]))split--;
            split=Math.max(offset+1,split-1);
            row=chars.slice(offset,split);end=split;
          }else{row.push(half(chars[end]));end++;}
        }
        out.push(row);offset=end;
      }
      return out.length?out:[[]];
    }));
  }
  function pages(lines,columns,lineCount){const wrapped=rows(lines,columns),out=[];for(let i=0;i<wrapped.length;i+=lineCount)out.push(wrapped.slice(i,i+lineCount).map(r=>r.join('')));return out;}
  const api={segments,rows,pages};if(typeof module==='object'&&module.exports)module.exports=api;else root.CaptionPagination=api;
})(typeof window==='object'?window:globalThis);
