"use strict";!function(){var e=document.querySelector(".prescription-amount");e&&new Cleave(e,{numeral:!0});const t=new Date,c=document.querySelectorAll(".prescription-date");c&&c.forEach(function(e){e.flatpickr({monthSelectorType:"static",defaultDate:t})})}();