$(document).ready(function(){

	/* Keep the Copywright year up to date */
	$('#CurrentYear').text( new Date().getFullYear() );
	
	Shadowbox.init();
	
	var imagesLoaded = false;
	
	// Only load the icons when the Sites tab is clicked
	$("#Sites").click(function() {
		
		if ( imagesLoaded == false ) {
			setTimeout( function() {
				
				$("img.lazy").lazyload({ 
					effect : "fadeIn"
				});

				imagesLoaded = true;
			}, 500 );
		}
	});
	
	/* Begin Icon Animations */
	
	$('.icon').mouseover(function() {
		$(this).animate({width: '128px', height: '128px'}, 'fast', function() {		
					
		});
	});
	
	$('.icon').mouseleave(function() {
		$(this).animate({width: '96px', height: '96px'}, 'fast', function() {		
				
		});
	});
	
	/* End Icon Animations */
	
	/* Begin Slider */
	
	var totalWidth = 0;
	var slideOffsets = new Array();
	
	$('#slides .slide').each(function(i){
		
		/* The slideOffsets array contains each slide's cummulative offset from the left part of the container */
		slideOffsets[i] = totalWidth;
		
		/* Traverse through all the slides and store their accumulative widths in totalWidth */
		totalWidth += $(this).width();
		
	});
	
	/* Change the container div's width to the exact width of all the slides combined */
	$('#slides').width(totalWidth);

	/* On a thumbnail click */
	$('#navigation-menu ul li a').click(function(e,keepScroll){			

			$('li.menuItem').removeClass('act').addClass('inact');
			$(this).parent().addClass('act');
			
			var pos = $(this).parent().prevAll('.menuItem').length;
			
			/* Start the sliding animation */
			$('#slides').stop().animate({marginLeft:-slideOffsets[pos]+'px'},450);
						
			e.preventDefault();
	});
	
	/* On page load, mark the first thumbnail as active */
	$('#navigation-menu ul li.menuItem:first').addClass('act').siblings().addClass('inact');
	
	/* End Slider */
});